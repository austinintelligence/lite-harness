import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { LocalWorkspaceSnapshotStore, ManagedWorkspaceLifecycle, StaticSnapshotKeyProvider } from "@lite-harness/workspace";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");

describe("Docker automatic workspace lifecycle", () => {
  it("BD-047-REGRESSION checkpoints cold, removes the volume, and restores it before the next run", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-docker-cold-lifecycle-"));
    const workspaceId = `cold-${Date.now()}`; const runId = `run_${Date.now()}`;
    const principal = { appId: "integration", tenantId: "local", userId: "cold-tester", scopes: [] };
    const owner = { id: runId, workspaceId, ...principal };
    const store = new SqliteRunStore(":memory:");
    const now = new Date().toISOString();
    store.createWorkspace({ id: workspaceId, ...principal, mode: "managed", state: "WARM", createdAt: now, updatedAt: now });
    store.createOrGetRun(runId, { agent: "coder", workspace: workspaceId, input: "cold lifecycle", idempotencyKey: runId, principal });
    const attempt = store.createRunAttempt(runId, `att_${Date.now()}`);
    const runtime = new DockerToolRuntime({ image, installationId: "docker-cold-lifecycle", containerStore: store });
    const lifecycle = new ManagedWorkspaceLifecycle(
      store, runtime, new LocalWorkspaceSnapshotStore(join(root, "snapshots"), new StaticSnapshotKeyProvider(Buffer.alloc(32, 9))),
    );
    const execute = (id: string, name: string, args: Record<string, unknown>) => runtime.execute({
      runId, attemptId: attempt.id, workspaceId, principal, call: { id, name, arguments: args },
    });
    try {
      await lifecycle.prepare(owner);
      expect((await execute("write-cold", "write_file", { path: "durable.txt", content: "survives cold restore" })).ok).toBe(true);
      await lifecycle.checkpoint(owner, { makeCold: true });
      expect(await runtime.workspaceExists(workspaceId, principal)).toBe(false);
      expect(store.getWorkspace(workspaceId, principal)?.state).toBe("COLD");
      await lifecycle.prepare(owner);
      expect((await execute("read-cold", "read_file", { path: "durable.txt" })).content).toBe("survives cold restore");
      expect(store.getWorkspace(workspaceId, principal)?.state).toBe("IN_USE");
      await lifecycle.checkpoint(owner);
    } finally {
      await runtime.removeWorkspace(workspaceId, principal).catch(() => undefined);
      store.close(); rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}
