import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactPublishingRuntime, CODING_TOOL_DEFINITIONS, InMemoryToolRuntime, validateWorkspacePath } from "@lite-harness/runtime";
import { DockerToolRuntime, type DockerCommandRunner } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

describe("tool runtime policy", () => {
  it.each(["/etc/passwd", "../escape", "folder/../escape", "C:\\Windows\\file", "a//b"])(
    "rejects unsafe workspace path %s",
    (path) => {
      expect(() => validateWorkspacePath(path)).toThrow(/Unsafe workspace path/);
    },
  );

  it("allows a portable relative workspace path", () => {
    expect(() => validateWorkspacePath("src/example.ts")).not.toThrow();
  });

  it("requires Docker images to be pinned by digest", () => {
    expect(() => new DockerToolRuntime({ image: "alpine:latest" })).toThrow(/pinned by sha256/);
  });

  it("BD-040-REGRESSION brokers bounded coding tools through hardened ephemeral containers", async () => {
    expect(CODING_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "shell_exec", "process_exec", "search_text", "patch_apply", "git_exec",
      "test_run", "build_run", "package_run",
    ]);
    const store = new SqliteRunStore(":memory:");
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: [] };
    store.createOrGetRun("run-code", { agent: "coder", workspace: "workspace", input: "code", idempotencyKey: "code", principal });
    const creates: string[][] = [];
    const inputs: string[] = [];
    let sequence = 0;
    let current = "";
    let exists = false;
    const runner: DockerCommandRunner = async (args, options) => {
      if (args[0] === "volume") return dockerOk("volume");
      if (args[0] === "run") return dockerOk();
      if (args[0] === "create") {
        creates.push([...args]); current = (++sequence).toString(16).padStart(64, "a"); exists = true; return dockerOk(current);
      }
      if (args[0] === "start") { if (options?.input) inputs.push(options.input); return dockerOk("command output"); }
      if (args[0] === "container" && args[1] === "inspect") return exists ? dockerOk(args.includes("--format") ? "false|exited" : "{}") : dockerMissing();
      if (args[0] === "container" && args[1] === "wait") return dockerOk("0");
      if (args[0] === "container" && args[1] === "rm") { exists = false; return dockerOk(current); }
      throw new Error(`Unexpected fake Docker command: ${args.join(" ")}`);
    };
    const runtime = new DockerToolRuntime({
      image: `sha256:${"d".repeat(64)}`, installationId: "installation", containerStore: store, commandRunner: runner,
    });
    const execute = (name: string, args: Record<string, unknown>) => runtime.execute({
      runId: "run-code", attemptId: "attempt", workspaceId: "workspace", principal,
      call: { id: `call-${name}-${sequence}`, name, arguments: args },
    });
    try {
      await expect(execute("shell_exec", { script: "printf safe", cwd: "." })).resolves.toMatchObject({ ok: true });
      await expect(execute("process_exec", { argv: ["node", "--version"] })).resolves.toMatchObject({ ok: true });
      await expect(execute("search_text", { pattern: "needle", paths: ["src"] })).resolves.toMatchObject({ ok: true });
      await expect(execute("patch_apply", { patch: "diff --git a/a b/a\n" })).resolves.toMatchObject({ ok: true });
      await expect(execute("git_exec", { args: ["status", "--short"] })).resolves.toMatchObject({ ok: true });
      await expect(execute("test_run", {})).resolves.toMatchObject({ ok: true });
      await expect(execute("build_run", { manager: "npm", script: "compile" })).resolves.toMatchObject({ ok: true });
      await expect(execute("package_run", { manager: "yarn" })).resolves.toMatchObject({ ok: true });
      await expect(execute("git_exec", { args: ["remote", "get-url", "origin"] })).rejects.toThrow(/not allowed/);
      await expect(execute("shell_exec", { script: "true", cwd: "../escape" })).rejects.toThrow(/Unsafe workspace path/);
      expect(inputs).toContain("printf safe");
      expect(creates.every((args) => args.includes("none") && args.includes("--read-only") && args.includes("1000:1000"))).toBe(true);
      const rendered = creates.map((args) => args.join(" ")).join("\n");
      for (const token of ["bash --noprofile", "node --version", "rg --line-number", "git -c core.hooksPath=/dev/null apply", "git -c core.hooksPath=/dev/null -c commit.gpgSign=false", "corepack pnpm run test", "npm run compile", "corepack yarn pack"]) {
        expect(rendered).toContain(token);
      }
      expect(store.listRuntimeContainers()).toEqual([]);
    } finally { store.close(); }
  });

  it("BD-041-REGRESSION defines the digest-pinned Debian glibc coding image and opt-in Python profile", () => {
    const dockerfile = readFileSync(join(process.cwd(), "docker", "tool-runtime", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("node:24-bookworm-slim@sha256:");
    for (const binary of ["bash", "ca-certificates", "git", "patch", "procps", "ripgrep", "tini"]) {
      expect(dockerfile).toMatch(new RegExp(`\\b${binary}\\b`));
    }
    expect(dockerfile).toContain("corepack prepare pnpm@11.7.0 --activate");
    expect(dockerfile).toContain("FROM runtime AS python-profile");
    expect(dockerfile).toContain("python3-venv");
    expect(dockerfile).toContain("USER node");
  });

  it("treats registered bind workspaces as operator-owned and never deletes or restores over them", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-bind-"));
    try {
      const runtime = new DockerToolRuntime({
        image: `sha256:${"a".repeat(64)}`,
        resolveRegisteredWorkspace: (id) => id === "registered" ? root : undefined,
      });
      await expect(runtime.removeWorkspace("registered")).rejects.toThrow(/cannot be deleted/);
      await expect(runtime.importWorkspace("registered", Buffer.from("archive"))).rejects.toThrow(/cannot be replaced/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps in-memory workspaces isolated", async () => {
    const runtime = new InMemoryToolRuntime();
    await runtime.execute({
      workspaceId: "one",
      call: { id: "tool-1", name: "write_file", arguments: { path: "a.txt", content: "one" } },
    });
    expect(runtime.readFile("one", "a.txt")).toBe("one");
    expect(runtime.readFile("two", "a.txt")).toBeUndefined();
  });

  it("BD-035-REGRESSION publishes only bytes read from an owned workspace path", async () => {
    let published: Buffer | undefined;
    const workspaceRuntime = new InMemoryToolRuntime();
    const runtime = new ArtifactPublishingRuntime(workspaceRuntime, {
      publish: (params) => {
        published = params.data;
        return {
          id: "art_00000000000000000000000000000000",
          runId: params.runId,
          appId: params.principal.appId,
          tenantId: params.principal.tenantId,
          userId: params.principal.userId,
          workspaceId: params.workspaceId,
          path: params.path,
          mediaType: params.mediaType,
          sizeBytes: params.data.length,
          sha256: "digest",
          createdAt: new Date().toISOString(),
        };
      },
    });
    await workspaceRuntime.execute({
      workspaceId: "one",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      call: { id: "tool-write", name: "write_file", arguments: { path: "reports/result.txt", content: "owned output" } },
    });
    const result = await runtime.execute({
      workspaceId: "one",
      runId: "run-one",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      call: { id: "tool-art", name: "artifact_publish", arguments: {
        path: "reports/result.txt", mediaType: "text/plain",
      } },
    });
    expect(result).toMatchObject({ ok: true, metadata: { artifactId: "art_00000000000000000000000000000000" } });
    expect(published?.toString("utf8")).toBe("owned output");
    await expect(runtime.execute({
      workspaceId: "one", runId: "run-one",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      call: { id: "tool-forged", name: "artifact_publish", arguments: {
        path: "reports/result.txt", mediaType: "text/plain", content: "forged bytes",
      } },
    })).rejects.toThrow(/authorized workspace path/);
  });
});

function dockerOk(stdout = ""): { code: number; stdout: string; stderr: string } { return { code: 0, stdout, stderr: "" }; }
function dockerMissing(): { code: number; stdout: string; stderr: string } { return { code: 1, stdout: "", stderr: "Error: No such container" }; }
