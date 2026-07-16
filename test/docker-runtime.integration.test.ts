import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import type { ToolExecutionContext } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");

describe("Docker runtime integration", () => {
  it("A22-REAL-PRELOADED-NO-PULL-NO-EGRESS uses only the local image, denies outbound TCP, and leaves no container", async () => {
    const identity = `${Date.now()}-${Math.random()}`;
    const workspaceId = `offline-${identity}`;
    const runId = `run-offline-${identity}`;
    const installationId = `offline-installation-${identity}`;
    const principal = { appId: "integration", tenantId: "offline", userId: "tester", scopes: [] };
    const store = new SqliteRunStore(":memory:");
    store.createOrGetRun(runId, { agent: "coder", workspace: workspaceId, input: "offline", idempotencyKey: runId, principal });
    const attempt = store.createRunAttempt(runId, `att-offline-${identity}`);
    const commands: string[][] = [];
    const runtime = new DockerToolRuntime({
      image, installationId, containerStore: store,
      commandRunner: async (args, options) => {
        commands.push([...args]);
        const result = spawnSync("docker", [...args], {
          input: options?.input, encoding: "utf8", windowsHide: true, timeout: 30_000,
        });
        if (result.error) throw result.error;
        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
    });
    try {
      const result = await runtime.execute({
        runId, attemptId: attempt.id, workspaceId, principal,
        call: {
          id: "offline-connect", name: "shell_exec", arguments: {
            script: "node -e \"const s=require('node:net').connect(443,'1.1.1.1',()=>process.exit(9));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(8),2000)\"",
          },
        },
      });
      expect(result).toMatchObject({ ok: true });
      const launches = commands.filter((args) => args[0] === "run" || args[0] === "create");
      expect(launches.length).toBeGreaterThanOrEqual(2);
      expect(launches.every((args) => args.includes("--pull=never") && hasPair(args, "--network", "none"))).toBe(true);
      expect(store.listRuntimeContainers()).toEqual([]);
      const installation = createHash("sha256").update(installationId).digest("hex").slice(0, 32);
      const listed = spawnSync("docker", ["ps", "--all", "--quiet", "--filter", `label=lite-harness.installation=${installation}`], { encoding: "utf8", windowsHide: true });
      expect(listed.status).toBe(0);
      expect(listed.stdout.trim()).toBe("");
    } finally {
      await runtime.removeWorkspace(workspaceId, principal).catch(() => undefined);
      store.close();
    }
  }, 60_000);

  it("A06-PAUSED-WRITER-MUTATION rejects an expired stale owner before Docker mutation and resumes the fenced owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-a06-paused-writer-"));
    const databasePath = join(root, "manager.db");
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const workspaceId = `a06-shared-workspace-${suffix}`;
    const principal = { appId: "a06-app", tenantId: "a06-tenant", userId: "a06-user", scopes: [] as string[] };
    const storeA = new SqliteRunStore(databasePath);
    const storeB = new SqliteRunStore(databasePath);
    const installationId = `a06-installation-${suffix}`;
    const runtimeA = new DockerToolRuntime({
      image, installationId, containerStore: storeA,
      validateExecutionLease: (params) => hasActiveFence(storeA, params),
    });
    const runtimeB = new DockerToolRuntime({
      image, installationId, containerStore: storeB,
      validateExecutionLease: (params) => hasActiveFence(storeB, params),
    });

    try {
      storeA.createOrGetRun("a06-run-a", {
        agent: "coder", workspace: workspaceId, input: "paused writer A", idempotencyKey: "a06-request-a", principal,
      });
      const attemptA = storeA.createRunAttempt("a06-run-a", "a06-attempt-a");
      storeB.createOrGetRun("a06-run-b", {
        agent: "coder", workspace: workspaceId, input: "resumed writer B", idempotencyKey: "a06-request-b", principal,
      });
      const attemptB = storeB.createRunAttempt("a06-run-b", "a06-attempt-b");

      const firstLease = storeA.acquireWorkspaceLease(workspaceId, "a06-run-a", 50);
      expect(firstLease).toMatchObject({ ownerRunId: "a06-run-a", fencingToken: 1 });
      const staleContext: ToolExecutionContext = {
        runId: "a06-run-a", attemptId: attemptA.id, workspaceId, principal,
        fencingToken: firstLease!.fencingToken,
        call: { id: "a06-stale-write", name: "write_file", arguments: { path: "stale.txt", content: "must not land" } },
      };

      await new Promise((resolve) => setTimeout(resolve, 100));
      const secondLease = storeB.acquireWorkspaceLease(workspaceId, "a06-run-b", 60_000);
      expect(secondLease).toMatchObject({ ownerRunId: "a06-run-b", fencingToken: 2 });
      expect(storeA.validateWorkspaceLease(firstLease!)).toBe(false);
      expect(storeB.validateWorkspaceLease(secondLease!)).toBe(true);

      await expect(runtimeA.execute(staleContext)).rejects.toThrow(/Workspace fence is not active/);
      expect(storeA.listRuntimeContainers()).toEqual([]);

      const resumedContext = (id: string, name: string, arguments_: Record<string, unknown>): ToolExecutionContext => ({
        runId: "a06-run-b", attemptId: attemptB.id, workspaceId, principal,
        fencingToken: secondLease!.fencingToken,
        call: { id, name, arguments: arguments_ },
      });
      await expect(runtimeB.execute(resumedContext("a06-resumed-write", "write_file", {
        path: "resumed.txt", content: "fenced owner wins\n",
      }))).resolves.toMatchObject({ ok: true });
      const read = await runtimeB.execute(resumedContext("a06-resumed-read", "read_file", { path: "resumed.txt" }));
      expect(read).toMatchObject({ ok: true, content: "fenced owner wins\n" });
      await expect(runtimeB.execute(resumedContext("a06-stale-read", "read_file", { path: "stale.txt" }))).resolves.toMatchObject({
        ok: false,
      });
      expect(storeA.listRuntimeContainers()).toEqual([]);
      expect(storeB.listRuntimeContainers()).toEqual([]);
    } finally {
      await runtimeB.removeWorkspace(workspaceId, principal).catch(() => undefined);
      storeA.close();
      storeB.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("A08-REAL-CLEANUP-MATRIX reaps tool containers after success, failure, cancel, timeout, and OOM", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const principal = { appId: "a08-app", tenantId: "a08-tenant", userId: "a08-user", scopes: [] as string[] };
    const runScenario = async (
      name: string,
      call: { id: string; name: string; arguments: Record<string, unknown> },
      options: { commandTimeoutMs?: number; memory?: string } = {},
      cancelWhenContainerAppears = false,
    ): Promise<void> => {
      const workspaceId = `a08-workspace-${name}-${suffix}`;
      const runId = `a08-run-${name}-${suffix}`;
      const installationId = `a08-installation-${name}-${suffix}`;
      const store = new SqliteRunStore(":memory:");
      const runtime = new DockerToolRuntime({ image, installationId, containerStore: store, ...options });
      const controller = new AbortController();
      try {
        store.createOrGetRun(runId, {
          agent: "coder", workspace: workspaceId, input: `A08 ${name}`, idempotencyKey: `a08-request-${name}-${suffix}`, principal,
        });
        const attempt = store.createRunAttempt(runId, `a08-attempt-${name}-${suffix}`);
        const execution = runtime.execute({ runId, attemptId: attempt.id, workspaceId, principal, call, signal: controller.signal });
        if (cancelWhenContainerAppears) {
          await waitForDockerContainers(installationId, 15_000);
          controller.abort(new Error("A08 cancellation requested"));
          await expect(execution).rejects.toThrow(/A08 cancellation requested|aborted/i);
        } else if (name === "timeout") {
          await expect(execution).rejects.toThrow(/timed out|aborted/i);
        } else {
          const result = await execution;
          expect(result.ok).toBe(name === "success" ? true : false);
        }
        await waitForDockerContainers(installationId, 15_000, true);
        expect(listManagedDockerContainers(installationId)).toEqual([]);
        expect(store.listRuntimeContainers()).toEqual([]);
      } finally {
        controller.abort();
        await runtime.removeWorkspace(workspaceId, principal).catch(() => undefined);
        store.close();
      }
    };

    await runScenario("success", { id: "a08-success", name: "shell_exec", arguments: { script: "printf 'success\\n'" } });
    await runScenario("failure", { id: "a08-failure", name: "shell_exec", arguments: { script: "exit 17" } });
    await runScenario(
      "cancel",
      { id: "a08-cancel", name: "shell_exec", arguments: { script: "sleep 30" } },
      {},
      true,
    );
    await runScenario(
      "timeout",
      { id: "a08-timeout", name: "shell_exec", arguments: { script: "sleep 30" } },
      { commandTimeoutMs: 100 },
    );
    await runScenario(
      "oom",
      { id: "a08-oom", name: "process_exec", arguments: {
        argv: ["node", "-e", "Buffer.allocUnsafe(256 * 1024 * 1024).fill(1); setTimeout(() => {}, 1000)"],
      } },
      { memory: "32m" },
    );
  }, 180_000);

  it("A07-REAL-TOOL-HARDENING-INSPECT enforces identity, rootfs, capability, network, CPU, memory, PID, and tmpfs limits", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const workspaceId = `a07-workspace-${suffix}`;
    const runId = `a07-run-${suffix}`;
    const installationId = `a07-installation-${suffix}`;
    const principal = { appId: "a07-app", tenantId: "a07-tenant", userId: "a07-user", scopes: [] as string[] };
    const store = new SqliteRunStore(":memory:");
    const runtime = new DockerToolRuntime({
      image, installationId, containerStore: store, memory: "32m", cpus: "0.5", pidsLimit: 32,
    });
    const controller = new AbortController();
    try {
      store.createOrGetRun(runId, {
        agent: "coder", workspace: workspaceId, input: "A07 hardening", idempotencyKey: `a07-request-${suffix}`, principal,
      });
      const attempt = store.createRunAttempt(runId, `a07-attempt-${suffix}`);
      const execution = runtime.execute({
        runId, attemptId: attempt.id, workspaceId, principal,
        call: { id: "a07-running-shell", name: "shell_exec", arguments: { script: "sleep 30" } },
        signal: controller.signal,
      });
      await waitForDockerContainers(installationId, 15_000);
      const containerId = listManagedDockerContainers(installationId)[0]!;
      const inspected = inspectDockerContainer(containerId);
      expect(inspected.Config.User).toBe("1000:1000");
      expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspected.HostConfig.NetworkMode).toBe("none");
      expect(inspected.HostConfig.CapDrop).toEqual(expect.arrayContaining(["ALL"]));
      expect(inspected.HostConfig.SecurityOpt).toEqual(expect.arrayContaining(["no-new-privileges"]));
      expect(inspected.HostConfig.Memory).toBe(32 * 1024 * 1024);
      expect(inspected.HostConfig.NanoCpus).toBe(500_000_000);
      expect(inspected.HostConfig.PidsLimit).toBe(32);
      expect(inspected.HostConfig.Tmpfs["/tmp"]).toMatch(/noexec/);
      controller.abort(new Error("A07 inspection complete"));
      await expect(execution).rejects.toThrow(/A07 inspection complete|aborted/i);
      await waitForDockerContainers(installationId, 15_000, true);
      expect(store.listRuntimeContainers()).toEqual([]);
    } finally {
      controller.abort();
      await runtime.removeWorkspace(workspaceId, principal).catch(() => undefined);
      store.close();
    }
  }, 90_000);

  it("persists a named-volume workspace across containers and restores an archive", async () => {
    const workspaceId = `integration-${Date.now()}`;
    const runId = `run_${Date.now()}`;
    const principal = { appId: "integration", tenantId: "local", userId: "tester", scopes: [] };
    const store = new SqliteRunStore(":memory:");
    store.createOrGetRun(runId, { agent: "coder", workspace: workspaceId, input: "integration", idempotencyKey: runId, principal });
    const attempt = store.createRunAttempt(runId, `att_${Date.now()}`);
    const runtime = new DockerToolRuntime({ image, installationId: "docker-integration", containerStore: store });
    const execute = (id: string, name: string, args: Record<string, unknown>) => runtime.execute({
      runId, attemptId: attempt.id, workspaceId, principal, call: { id, name, arguments: args },
    });
    try {
      const write = await execute("write-1", "write_file", { path: "hello.txt", content: "hello docker" });
      expect(write.ok).toBe(true);
      const shell = await execute("shell-1", "shell_exec", { script: "node --version && git --version && rg --version" });
      expect(shell).toMatchObject({ ok: true, content: expect.stringContaining("v24.") });
      const search = await execute("search-1", "search_text", { pattern: "hello docker", paths: ["hello.txt"], fixedStrings: true });
      expect(search).toMatchObject({ ok: true, content: expect.stringContaining("hello docker") });
      const archive = await runtime.exportWorkspace(workspaceId, principal);
      await execute("write-2", "write_file", { path: "hello.txt", content: "changed" });
      await runtime.importWorkspace(workspaceId, archive, principal);
      const restored = await execute("read-1", "read_file", { path: "hello.txt" });
      expect(restored.content).toBe("hello docker");
    } finally {
      await runtime.removeWorkspace(workspaceId, principal);
      store.close();
    }
  }, 60_000);

  it("rejects artifact reads through final and intermediate symlinks outside the workspace", async () => {
    const workspaceId = `artifact-links-${Date.now()}`;
    const runId = `run-links-${Date.now()}`;
    const principal = { appId: "integration", tenantId: "local", userId: "link-tester", scopes: [] };
    const store = new SqliteRunStore(":memory:");
    store.createOrGetRun(runId, { agent: "coder", workspace: workspaceId, input: "artifact links", idempotencyKey: runId, principal });
    const attempt = store.createRunAttempt(runId, `att-${Date.now()}`);
    const runtime = new DockerToolRuntime({ image, installationId: "docker-artifact-links", containerStore: store });
    const execute = (id: string, script: string) => runtime.execute({
      runId, attemptId: attempt.id, workspaceId, principal,
      call: { id, name: "shell_exec", arguments: { script } },
    });
    const read = (path: string) => runtime.readWorkspaceArtifact({
      runId, attemptId: attempt.id, workspaceId, principal, fencingToken: 1,
      call: { id: `read-${path}`, name: "artifact_read", arguments: { path } },
      path, maxBytes: 16 * 1024,
    });
    try {
      await expect(execute("link-final", "ln -s /etc/passwd escape.txt")).resolves.toMatchObject({ ok: true });
      await expect(read("escape.txt")).rejects.toThrow(/escapes workspace/i);
      await expect(execute("link-directory", "ln -s /etc linked")).resolves.toMatchObject({ ok: true });
      await expect(read("linked/passwd")).rejects.toThrow(/escapes workspace/i);
    } finally {
      await runtime.removeWorkspace(workspaceId, principal).catch(() => undefined);
      store.close();
    }
  }, 60_000);
});

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}

function hasPair(args: readonly string[], name: string, value: string): boolean {
  return args.some((item, index) => item === name && args[index + 1] === value);
}

function hasActiveFence(store: SqliteRunStore, params: ToolExecutionContext): boolean {
  if (!params.runId || !params.attemptId || !params.principal || params.fencingToken === undefined) return false;
  const run = store.getRun(params.runId);
  if (!run || run.workspaceId !== params.workspaceId || run.appId !== params.principal.appId ||
      run.tenantId !== params.principal.tenantId || run.userId !== params.principal.userId) return false;
  const attempt = store.listRunAttempts(run.id).findLast((item) => item.status === "RUNNING");
  const lease = store.getWorkspaceLease(run.workspaceId, run.id);
  return attempt?.id === params.attemptId && lease?.fencingToken === params.fencingToken &&
    store.validateWorkspaceLease(lease);
}

function listManagedDockerContainers(installationId: string): string[] {
  const result = spawnSync("docker", [
    "ps", "--all", "--quiet", "--filter", "label=lite-harness.managed=true",
    "--filter", `label=lite-harness.installation=${digestLabel(installationId)}`,
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect A08 Docker inventory: ${result.stderr || result.stdout}`);
  return (result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function inspectDockerContainer(containerId: string): {
  Config: { User: string };
  HostConfig: {
    ReadonlyRootfs: boolean; NetworkMode: string; CapDrop: string[]; SecurityOpt: string[];
    Memory: number; NanoCpus: number; PidsLimit: number; Tmpfs: Record<string, string>;
  };
} {
  const result = spawnSync("docker", ["container", "inspect", containerId], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect A07 Docker container: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout ?? "") as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object") throw new Error("A07 Docker inspect output was invalid");
  return parsed[0] as ReturnType<typeof inspectDockerContainer>;
}

async function waitForDockerContainers(installationId: string, timeoutMs: number, empty = false): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = listManagedDockerContainers(installationId).length;
    if ((empty && count === 0) || (!empty && count > 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for A08 ${empty ? "empty" : "active"} Docker inventory`);
}

function digestLabel(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
