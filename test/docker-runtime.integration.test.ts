import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
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
