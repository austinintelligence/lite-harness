import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway, type ModelGateway } from "@lite-harness/agent-runtime";
import { RunService, type WorkspaceRunLifecycle } from "@lite-harness/control-plane";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { LocalWorkspaceSnapshotStore, ManagedWorkspaceLifecycle, StaticSnapshotKeyProvider } from "@lite-harness/workspace";
import { completeTreeContract } from "./support/complete-tree.js";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");

describe("Docker automatic workspace lifecycle", () => {
  it("A10-REAL-RESTORE BD-047-REGRESSION runs the compactor cold and automatically restores the complete tree before the next run", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-docker-cold-lifecycle-"));
    const workspaceId = `cold-${Date.now()}`;
    const principal = { appId: "integration", tenantId: "local", userId: "cold-tester", scopes: [] as string[] };
    const store = new SqliteRunStore(":memory:");
    const runtime = new DockerToolRuntime({ image, installationId: "docker-cold-lifecycle", containerStore: store });
    const managed = new ManagedWorkspaceLifecycle(
      store, runtime, new LocalWorkspaceSnapshotStore(join(root, "snapshots"), new StaticSnapshotKeyProvider(Buffer.alloc(32, 9))),
    );
    let checkpointedTree: ReturnType<typeof completeTreeContract> | undefined;
    let restoredTree: ReturnType<typeof completeTreeContract> | undefined;
    const restoreToModelOrder: string[] = [];
    const lifecycle: WorkspaceRunLifecycle = {
      prepare: async (run, signal) => {
        const prepared = await managed.prepare(run, signal);
        if (prepared.restored) {
          restoredTree = completeTreeContract(await runtime.exportWorkspace(run.workspaceId, principal, signal));
          restoreToModelOrder.push("restore-complete");
        }
        return prepared;
      },
      checkpoint: async (run, options) => {
        if (options?.makeCold) {
          checkpointedTree = completeTreeContract(await runtime.exportWorkspace(run.workspaceId, principal, options.signal));
        }
        return await managed.checkpoint(run, options);
      },
    };
    const fakeModel = new FakeModelGateway();
    let subsequentRunModelObserved = false;
    const model: ModelGateway = {
      async *streamTurn(params) {
        const isSubsequentRun = params.messages.some((message) =>
          message.role === "user" && message.content === "subsequent automatic restore");
        if (isSubsequentRun && !subsequentRunModelObserved) {
          subsequentRunModelObserved = true;
          expect(restoredTree).toBeDefined();
          restoreToModelOrder.push("model-called");
        }
        yield* fakeModel.streamTurn(params);
      },
    };
    const service = new RunService(store, new AgentRunner(model, runtime), {
      workspaceLifecycle: lifecycle,
      makeWorkspaceColdAfterCheckpoint: (run) => run.input === "first automatic checkpoint",
    });

    try {
      const setupRunId = `run_setup_${Date.now()}`;
      store.createOrGetRun(setupRunId, {
        agent: "coder", workspace: workspaceId, input: "fixture setup", idempotencyKey: setupRunId, principal,
      });
      const setupAttempt = store.createRunAttempt(setupRunId, `att_setup_${Date.now()}`);
      const setup = await runtime.execute({
        runId: setupRunId, attemptId: setupAttempt.id, workspaceId, principal,
        call: {
          id: "seed-complete-tree",
          name: "shell_exec",
          arguments: {
            script: "mkdir -p empty nested && printf '%s' '{\"mode\":384}' > nested/metadata.json && chmod 0750 empty && chmod 0600 nested/metadata.json",
          },
        },
      });
      expect(setup).toMatchObject({ ok: true });
      store.completeRunAttempt(setupAttempt.id, "SUCCEEDED");

      const first = service.createRun({
        agent: "coder", workspace: workspaceId, input: "first automatic checkpoint", idempotencyKey: "first-automatic-checkpoint", principal,
      });
      expect((await service.waitForTerminal(first.runId, 45_000)).status).toBe("SUCCEEDED");
      expect(store.getWorkspace(workspaceId, principal)?.state).toBe("COLD");
      expect(await runtime.workspaceExists(workspaceId, principal)).toBe(false);
      const firstEvents = service.listEvents(first.runId).map((event) => event.type);
      expect(firstEvents).toEqual(expect.arrayContaining([
        "run.checkpointing", "workspace.checkpoint.completed", "workspace.lease.released", "run.succeeded",
      ]));
      expect(firstEvents.indexOf("run.checkpointing")).toBeLessThan(firstEvents.indexOf("workspace.checkpoint.completed"));
      expect(firstEvents.indexOf("workspace.checkpoint.completed")).toBeLessThan(firstEvents.indexOf("workspace.lease.released"));
      expect(firstEvents.indexOf("workspace.lease.released")).toBeLessThan(firstEvents.indexOf("run.succeeded"));

      const second = service.createRun({
        agent: "coder", workspace: workspaceId, input: "subsequent automatic restore", idempotencyKey: "subsequent-automatic-restore", principal,
      });
      expect((await service.waitForTerminal(second.runId, 45_000)).status).toBe("SUCCEEDED");
      const secondEvents = service.listEvents(second.runId).map((event) => event.type);
      expect(secondEvents.indexOf("workspace.restore.completed")).toBeGreaterThanOrEqual(0);
      expect(secondEvents.indexOf("workspace.restore.completed")).toBeLessThan(secondEvents.indexOf("run.started"));
      expect(restoreToModelOrder).toEqual(["restore-complete", "model-called"]);
      expect(checkpointedTree).toBeDefined();
      expect(restoredTree).toEqual(checkpointedTree);
      expect(checkpointedTree?.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "empty", type: "5", mode: 0o750, size: 0 }),
        expect.objectContaining({ path: "nested", type: "5" }),
        expect.objectContaining({ path: "nested/metadata.json", type: "0", mode: 0o600, size: 12 }),
      ]));
      expect(store.getWorkspace(workspaceId, principal)?.state).toBe("WARM");
    } finally {
      await service.shutdown().catch(() => undefined);
      await runtime.removeWorkspace(workspaceId, principal).catch(() => undefined);
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}
