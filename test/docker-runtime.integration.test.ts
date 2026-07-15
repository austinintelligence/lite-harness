import { describe, expect, it } from "vitest";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");

describe("Docker runtime integration", () => {
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
});

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}
