import { describe, expect, it } from "vitest";
import type { DockerCommandRunner } from "@lite-harness/runtime-docker";
import { DockerToolRuntime, killAndReapContainer } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const image = `sha256:${"f".repeat(64)}`;
const principal = { appId: "app-one", tenantId: "tenant-one", userId: "user-one", scopes: [] };

describe("durable Docker tool lifecycle", () => {
  it("BD-019-REGRESSION persists identity before start, uses deterministic ownership labels, and reconciles leftovers", async () => {
    const store = runStore("run-durable");
    try {
      const commands: string[][] = [];
      const createNames: string[] = [];
      let nextId = 1;
      let currentId = "";
      let exists = false;
      let observedPersistedBeforeStart = false;
      const runner: DockerCommandRunner = async (args) => {
        commands.push([...args]);
        if (args[0] === "volume") return ok("volume");
        if (args[0] === "run") return ok();
        if (args[0] === "create") {
          createNames.push(args[args.indexOf("--name") + 1]!);
          currentId = nextId.toString(16).padStart(64, "a");
          nextId += 1;
          exists = true;
          return ok(currentId);
        }
        if (args[0] === "start") {
          observedPersistedBeforeStart = store.listRuntimeContainers().some((record) =>
            record.runtimeContainerId === currentId && record.state === "RUNNING");
          return ok("owned file");
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return exists
            ? ok(args.includes("--format") ? "false|exited" : "{}")
            : missing();
        }
        if (args[0] === "container" && args[1] === "wait") return ok("0");
        if (args[0] === "container" && args[1] === "rm") { exists = false; return ok(currentId); }
        if (args[0] === "ps") return ok(currentId);
        throw new Error(`Unexpected fake Docker command: ${args.join(" ")}`);
      };
      const runtime = new DockerToolRuntime({
        image, installationId: "installation-one", containerStore: store, commandRunner: runner,
      });
      const execute = () => runtime.execute({
        runId: "run-durable", attemptId: "attempt-one", workspaceId: "workspace-one", principal,
        call: { id: "call-one", name: "read_file", arguments: { path: "owned.txt" } },
      });

      await expect(execute()).resolves.toMatchObject({ ok: true, content: "owned file" });
      await expect(execute()).resolves.toMatchObject({ ok: true, content: "owned file" });
      expect(observedPersistedBeforeStart).toBe(true);
      expect(store.listRuntimeContainers()).toEqual([]);
      expect(createNames).toHaveLength(2);
      expect(createNames[0]).toBe(createNames[1]);
      const create = commands.find((args) => args[0] === "create")!;
      expect(create).toContain("lite-harness.managed=true");
      for (const label of ["installation", "app", "tenant", "user", "workspace", "run", "attempt", "tool-call"]) {
        expect(create.some((value) => value.startsWith(`lite-harness.${label}=`))).toBe(true);
      }
      expect(create).not.toContain("--rm");

      const staleId = "b".repeat(64);
      store.recordRuntimeContainer({
        runtimeContainerId: staleId, containerName: "lite-harness-tool-stale", runId: "run-durable",
        attemptId: "attempt-one", workspaceIdentity: "workspace-digest", toolCallId: "call-stale",
        state: "RUNNING", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      currentId = staleId;
      exists = true;
      const reaped = await runtime.reconcileContainers();
      expect(reaped).toBe(1);
      expect(store.listRuntimeContainers()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("BD-020-REGRESSION independently kills, waits for, removes, and verifies an aborted container", async () => {
    const store = runStore("run-cancel");
    try {
      const commands: string[][] = [];
      const runtimeContainerId = "c".repeat(64);
      let exists = false;
      let running = false;
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
      const runner: DockerCommandRunner = async (args, options) => {
        commands.push([...args]);
        if (args[0] === "volume") return ok("volume");
        if (args[0] === "run") return ok();
        if (args[0] === "create") { exists = true; return ok(runtimeContainerId); }
        if (args[0] === "start") {
          running = true;
          notifyStarted();
          return await new Promise((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        }
        if (args[0] === "container" && args[1] === "inspect") {
          return exists
            ? ok(args.includes("--format") ? `${running}|${running ? "running" : "exited"}` : "{}")
            : missing();
        }
        if (args[0] === "container" && args[1] === "kill") { running = false; return ok(runtimeContainerId); }
        if (args[0] === "container" && args[1] === "wait") return ok("137");
        if (args[0] === "container" && args[1] === "rm") { exists = false; return ok(runtimeContainerId); }
        throw new Error(`Unexpected fake Docker command: ${args.join(" ")}`);
      };
      const runtime = new DockerToolRuntime({
        image, installationId: "installation-one", containerStore: store, commandRunner: runner,
      });
      const controller = new AbortController();
      const execution = runtime.execute({
        runId: "run-cancel", attemptId: "attempt-cancel", workspaceId: "workspace-one", principal,
        call: { id: "call-cancel", name: "read_file", arguments: { path: "owned.txt" } },
        signal: controller.signal,
      });
      await started;
      controller.abort(new Error("cancelled by regression test"));
      await expect(execution).rejects.toThrow(/cancelled by regression test/);

      const lifecycle = commands.map((args) => args.slice(0, 2).join(" "));
      expect(lifecycle).toContain("container kill");
      expect(lifecycle).toContain("container wait");
      expect(lifecycle).toContain("container rm");
      expect(lifecycle.filter((command) => command === "container inspect")).toHaveLength(2);
      expect(store.listRuntimeContainers()).toEqual([]);
      expect(exists).toBe(false);
    } finally {
      store.close();
    }
  });

  it("removes an already-exited container without waiting on a stale Docker event", async () => {
    const commands: string[][] = [];
    let exists = true;
    const runner: DockerCommandRunner = async (args) => {
      commands.push([...args]);
      if (args[0] === "container" && args[1] === "inspect") {
        return exists ? ok(args.includes("--format") ? "false|exited" : "{}") : missing();
      }
      if (args[0] === "container" && args[1] === "rm") { exists = false; return ok("removed"); }
      throw new Error(`Unexpected fake Docker command: ${args.join(" ")}`);
    };

    await killAndReapContainer(runner, "terminal-plugin-container");

    expect(commands.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "container inspect", "container rm", "container inspect",
    ]);
    expect(exists).toBe(false);
  });

  it("treats a natural exit between inspect and kill as terminal and still removes the container", async () => {
    const commands: string[][] = [];
    let exists = true;
    const runner: DockerCommandRunner = async (args) => {
      commands.push([...args]);
      if (args[0] === "container" && args[1] === "inspect") {
        return exists ? ok(args.includes("--format") ? "true|running" : "{}") : missing();
      }
      if (args[0] === "container" && args[1] === "kill") {
        return { code: 1, stdout: "", stderr: "Error response from daemon: cannot kill container: fixture is not running" };
      }
      if (args[0] === "container" && args[1] === "rm") { exists = false; return ok("removed"); }
      throw new Error(`Unexpected fake Docker command: ${args.join(" ")}`);
    };

    await killAndReapContainer(runner, "naturally-exited-plugin-container");

    expect(commands.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "container inspect", "container kill", "container rm", "container inspect",
    ]);
    expect(exists).toBe(false);
  });
});

function runStore(runId: string): SqliteRunStore {
  const store = new SqliteRunStore(":memory:");
  store.createOrGetRun(runId, {
    agent: "coder", workspace: "workspace-one", input: "test", idempotencyKey: `${runId}-key`, principal,
  });
  return store;
}

function ok(stdout = ""): { code: number; stdout: string; stderr: string } {
  return { code: 0, stdout, stderr: "" };
}

function missing(): { code: number; stdout: string; stderr: string } {
  return { code: 1, stdout: "", stderr: "Error: No such container" };
}
