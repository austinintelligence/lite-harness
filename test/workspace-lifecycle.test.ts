import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import type { RunRecord } from "@lite-harness/contracts";
import { RunService, type WorkspaceRunLifecycle } from "@lite-harness/control-plane";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import {
  LocalWorkspaceSnapshotStore, ManagedWorkspaceLifecycle, StaticSnapshotKeyProvider,
  workspaceSnapshotIdentity, type SnapshotKeyProvider, type WorkspaceLifecycleRuntime, type WorkspaceLifecycleStore,
} from "@lite-harness/workspace";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("automatic workspace snapshot lifecycle", () => {
  it("A10-STATE-MACHINE restores cold state before use and deletes warm data only after a verified checkpoint", async () => {
    const store = new SqliteRunStore(temporary("state.sqlite"));
    const snapshots = new LocalWorkspaceSnapshotStore(temporary("snapshots"), new StaticSnapshotKeyProvider(Buffer.alloc(32, 7)));
    const runtime = new MemoryWorkspaceRuntime();
    const transitions: string[] = [];
    const lifecycleStore: WorkspaceLifecycleStore = {
      getWorkspace: (id, owner) => store.getWorkspace(id, owner),
      updateWorkspaceState: (id, owner, expected, state) => {
        transitions.push(`${expected}->${state}`);
        return store.updateWorkspaceState(id, owner, expected, state);
      },
    };
    const lifecycle = new ManagedWorkspaceLifecycle(lifecycleStore, runtime, snapshots);
    const run = owner("workspace-cold");
    createWorkspace(store, run, "WARM");

    expect(await lifecycle.prepare(run)).toEqual({ restored: false, recoveredFromPrevious: false });
    expect(store.getWorkspace(run.workspaceId, run)?.state).toBe("IN_USE");
    runtime.archive = Buffer.from("first verified workspace archive");
    const cold = await lifecycle.checkpoint(run, { makeCold: true });
    expect(cold).toMatchObject({ state: "COLD", skipped: false, snapshot: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(runtime.exists).toBe(false);
    expect(store.getWorkspace(run.workspaceId, run)?.state).toBe("COLD");

    runtime.archive = Buffer.from("wrong empty volume");
    expect(await lifecycle.prepare(run)).toEqual({ restored: true, recoveredFromPrevious: false });
    expect(runtime.archive.toString()).toBe("first verified workspace archive");
    expect(store.getWorkspace(run.workspaceId, run)?.state).toBe("IN_USE");
    await lifecycle.checkpoint(run);
    expect(store.getWorkspace(run.workspaceId, run)?.state).toBe("WARM");
    expect(transitions).toEqual([
      "WARM->IN_USE",
      "IN_USE->SNAPSHOTTING",
      "SNAPSHOTTING->COLD",
      "COLD->RESTORING",
      "RESTORING->WARM",
      "WARM->IN_USE",
      "IN_USE->SNAPSHOTTING",
      "SNAPSHOTTING->WARM",
    ]);
    store.close();
  });

  it("A10-VERIFICATION-FENCE retains the warm volume when authenticated staged-snapshot verification fails", async () => {
    const store = new SqliteRunStore(temporary("state.sqlite"));
    let keyRead = 0;
    const changingKey: SnapshotKeyProvider = {
      getKey: async () => Buffer.alloc(32, keyRead++ === 0 ? 3 : 4),
    };
    const snapshots = new LocalWorkspaceSnapshotStore(temporary("snapshots"), changingKey);
    const runtime = new MemoryWorkspaceRuntime();
    runtime.exists = true;
    runtime.archive = Buffer.from("warm data must survive failed staged verification");
    const lifecycle = new ManagedWorkspaceLifecycle(store, runtime, snapshots);
    const run = owner("workspace-verification-failure");
    createWorkspace(store, run, "WARM");

    await lifecycle.prepare(run);
    await expect(lifecycle.checkpoint(run, { makeCold: true })).rejects.toThrow(/authentic|snapshot|decrypt/i);
    expect(keyRead).toBe(2);
    expect(runtime.removals).toBe(0);
    expect(runtime.exists).toBe(true);
    expect(runtime.archive.toString()).toBe("warm data must survive failed staged verification");
    expect(store.getWorkspace(run.workspaceId, run)?.state).toBe("ERROR");
    store.close();
  });

  it("marks authenticated cold state CORRUPT without replacing the warm volume", async () => {
    const store = new SqliteRunStore(temporary("state.sqlite"));
    const snapshots = new LocalWorkspaceSnapshotStore(temporary("snapshots"), new StaticSnapshotKeyProvider(Buffer.alloc(32, 8)));
    const runtime = new MemoryWorkspaceRuntime();
    const lifecycle = new ManagedWorkspaceLifecycle(store, runtime, snapshots);
    const run = owner("workspace-corrupt");
    createWorkspace(store, run, "COLD");
    const record = await snapshots.create(workspaceSnapshotIdentity(run), Buffer.from("known good"));
    writeFileSync(record.path, "tampered", { flag: "w" });
    await expect(lifecycle.prepare(run)).rejects.toThrow(/No valid snapshot/);
    expect(store.getWorkspace(run.workspaceId, run)?.state).toBe("CORRUPT");
    expect(runtime.imports).toBe(0);
    expect(runtime.removals).toBe(0);
    store.close();
  });

  it("A10-RUN-CHECKPOINT enters run checkpointing and completes the workspace checkpoint before terminal success", async () => {
    const store = new SqliteRunStore(":memory:");
    let released = false;
    const lifecycle: WorkspaceRunLifecycle = {
      prepare: async () => ({ restored: true, recoveredFromPrevious: false }),
      checkpoint: async () => {
        expect(released).toBe(false);
        return { state: "WARM", skipped: false, snapshot: { sha256: "a".repeat(64), plaintextBytes: 10 } };
      },
    };
    const wrapped = new Proxy(store, {
      get(target, property) {
        if (property === "releaseWorkspaceLease") return (lease: Parameters<typeof store.releaseWorkspaceLease>[0]) => {
          released = store.releaseWorkspaceLease(lease); return released;
        };
        const value = target[property as keyof SqliteRunStore];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new RunService(wrapped, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()), { workspaceLifecycle: lifecycle });
    const created = service.createRun({
      agent: "coder", workspace: "workspace", input: "checkpoint", idempotencyKey: "checkpoint",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
    });
    expect((await service.waitForTerminal(created.runId)).status).toBe("SUCCEEDED");
    expect(service.listEvents(created.runId).map((event) => event.type)).toEqual(expect.arrayContaining([
      "workspace.restore.completed", "run.checkpointing", "workspace.lease.released", "workspace.checkpoint.completed", "run.succeeded",
    ]));
    const events = service.listEvents(created.runId).map((event) => event.type);
    expect(events.indexOf("workspace.checkpoint.completed")).toBeLessThan(events.indexOf("workspace.lease.released"));
    expect(events.indexOf("workspace.lease.released")).toBeLessThan(events.indexOf("run.succeeded"));
    await service.shutdown(); store.close();
  });
});

class MemoryWorkspaceRuntime implements WorkspaceLifecycleRuntime {
  exists = false; archive = Buffer.alloc(0); imports = 0; removals = 0;
  async workspaceExists(): Promise<boolean> { return this.exists; }
  async exportWorkspace(): Promise<Buffer> { this.exists = true; return Buffer.from(this.archive); }
  async importWorkspace(_workspaceId: string, archive: Buffer): Promise<void> { this.imports += 1; this.archive = Buffer.from(archive); this.exists = true; }
  async removeWorkspace(): Promise<boolean> { this.removals += 1; const existed = this.exists; this.exists = false; return existed; }
}

function owner(workspaceId: string) { return { id: `run-${workspaceId}`, workspaceId, appId: "app", tenantId: "tenant", userId: "user" }; }
function createWorkspace(store: SqliteRunStore, run: ReturnType<typeof owner>, state: "WARM" | "COLD") {
  const now = new Date().toISOString();
  store.createWorkspace({ id: run.workspaceId, appId: run.appId, tenantId: run.tenantId, userId: run.userId, mode: "managed", state, createdAt: now, updatedAt: now });
}
function temporary(name: string): string { const root = mkdtempSync(join(tmpdir(), "lite-workspace-lifecycle-")); roots.push(root); return join(root, name); }
