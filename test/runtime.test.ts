import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactPublishingRuntime, CODING_TOOL_DEFINITIONS, InMemoryToolRuntime, validateWorkspacePath, type ToolRuntime } from "@lite-harness/runtime";
import { DockerToolRuntime, dockerMaintenanceHardeningArgs, type DockerCommandRunner } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

describe("tool runtime policy", () => {
  it("D04 keeps the Docker runtime limited to untrusted tools and free of model-provider dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "packages", "runtime-docker", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@lite-harness/contracts", "@lite-harness/runtime",
    ]);
    const source = readFileSync(join(process.cwd(), "packages", "runtime-docker", "src", "index.ts"), "utf8");
    expect(source).not.toMatch(/provider|model gateway|credential broker/i);
  });

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

  it("A07-MAINTENANCE-HARDENING-ARGS applies one bounded policy to init, export, import, copy, and restore containers", () => {
    const args = dockerMaintenanceHardeningArgs({ memory: "48m", cpus: "0.25", pidsLimit: 32 }, { user: "1000:1000" });
    expect(args).toEqual(expect.arrayContaining([
      "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges=true", "--pids-limit", "32",
      "--memory", "48m", "--memory-swap", "48m", "--cpus", "0.25", "--ulimit", "nofile=1024:1024",
      "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
      "--user", "1000:1000",
    ]));
    expect(args).not.toContain("seccomp=default");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--network=host");
  });

  it("D15 BD-040-REGRESSION defaults workspaces to Docker named volumes for bounded coding tools", async () => {
    expect(CODING_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "shell_exec", "process_exec", "search_text", "patch_apply", "git_exec",
      "test_run", "build_run", "package_run",
    ]);
    const store = new SqliteRunStore(":memory:");
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: [] };
    store.createOrGetRun("run-code", { agent: "coder", workspace: "workspace", input: "code", idempotencyKey: "code", principal });
    const creates: string[][] = [];
    const runs: string[][] = [];
    const volumes: string[][] = [];
    const inputs: string[] = [];
    let sequence = 0;
    let current = "";
    let currentCreateArgs: string[] = [];
    let exists = false;
    const runner: DockerCommandRunner = async (args, options) => {
      if (args[0] === "volume") { volumes.push([...args]); return dockerOk("volume"); }
      if (args[0] === "run") { runs.push([...args]); return dockerOk(); }
      if (args[0] === "create") {
        creates.push([...args]); currentCreateArgs = [...args]; current = (++sequence).toString(16).padStart(64, "a"); exists = true; return dockerOk(current);
      }
      if (args[0] === "start") { if (options?.input) inputs.push(options.input); return dockerOk(currentCreateArgs.includes("lite-quota") ? "0 0" : "command output"); }
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
      expect(volumes.some((args) => args[1] === "create")).toBe(true);
      expect(creates.every((args) => args.includes("--pull=never") && args.includes("none") && args.includes("--read-only") && args.includes("1000:1000"))).toBe(true);
      expect(creates.every((args) => args.includes("--memory-swap") && args.includes("256m") &&
        args.includes("nofile=1024:1024") && !args.includes("seccomp=default") &&
        args.includes("--log-driver") && args.includes("json-file") &&
        args.includes("max-size=10m") && args.includes("max-file=3"))).toBe(true);
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((args) => args.includes("--pull=never") && args.includes("none"))).toBe(true);
      const rendered = creates.map((args) => args.join(" ")).join("\n");
      expect(rendered).toContain("type=volume");
      for (const token of ["bash --noprofile", "node --version", "rg --line-number", "git -c core.hooksPath=/dev/null apply", "git -c core.hooksPath=/dev/null -c commit.gpgSign=false", "corepack pnpm run test", "npm run compile", "corepack yarn pack"]) {
        expect(rendered).toContain(token);
      }
      expect(store.listRuntimeContainers()).toEqual([]);
    } finally { store.close(); }
  });

  it("DOCKER-002 applies a post-mutation quota boundary after a command and leaves no tool container behind", async () => {
    const store = new SqliteRunStore(":memory:");
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: [] };
    store.createOrGetRun("run-quota", { agent: "coder", workspace: "workspace", input: "quota", idempotencyKey: "quota", principal });
    let current = "";
    let currentCreateArgs: string[] = [];
    let exists = false;
    let overQuota = false;
    const runner: DockerCommandRunner = async (args) => {
      if (args[0] === "volume" || args[0] === "run") return dockerOk("volume");
      if (args[0] === "create") {
        current = "e".repeat(64);
        currentCreateArgs = [...args];
        exists = true;
        return dockerOk(current);
      }
      if (args[0] === "start") {
        return currentCreateArgs.includes("lite-quota")
          ? dockerOk(overQuota ? "2048 0" : "0 0")
          : dockerOk("mutated");
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return exists ? dockerOk(args.includes("--format") ? "false|exited" : "{}") : dockerMissing();
      }
      if (args[0] === "container" && args[1] === "wait") return dockerOk("0");
      if (args[0] === "container" && args[1] === "rm") { exists = false; return dockerOk(current); }
      throw new Error(`Unexpected fake Docker command: ${args.join(" ")}`);
    };
    const runtime = new DockerToolRuntime({
      image: `sha256:${"e".repeat(64)}`,
      installationId: "installation",
      containerStore: store,
      commandRunner: runner,
      workspaceQuotaBytes: 1024 * 1024,
    });
    const execute = () => runtime.execute({
      runId: "run-quota", attemptId: "attempt", workspaceId: "workspace", principal,
      call: { id: "call-shell", name: "shell_exec", arguments: { script: "printf changed", cwd: "." } },
    });
    try {
      await expect(execute()).resolves.toMatchObject({ ok: true });
      overQuota = true;
      await expect(execute()).rejects.toThrow(/Workspace mutation exceeded/);
      expect(store.listRuntimeContainers()).toEqual([]);
      expect(exists).toBe(false);
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

  it("D16 treats explicitly registered bind workspaces as optional operator-owned developer mode", async () => {
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

  it("BD-035-REGRESSION does not publish bytes after the reader loses its fence", async () => {
    let active = true;
    let published = false;
    const inner: ToolRuntime = {
      execute: async () => ({ callId: "unused", ok: false, content: "unused" }),
      readWorkspaceArtifact: async () => {
        active = false;
        return Buffer.from("late bytes");
      },
    };
    const runtime = new ArtifactPublishingRuntime(inner, {
      publish: () => {
        published = true;
        return {
          id: "art_00000000000000000000000000000001",
          runId: "run-fence", appId: "app", tenantId: "tenant", userId: "user", workspaceId: "workspace",
          path: "result.txt", mediaType: "text/plain", sizeBytes: 9, sha256: "digest", createdAt: new Date().toISOString(),
        };
      },
    }, undefined, (params) => active && params.fencingToken === 1);

    await expect(runtime.execute({
      workspaceId: "workspace", runId: "run-fence", attemptId: "attempt-fence", fencingToken: 1,
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      call: { id: "tool-fence", name: "artifact_publish", arguments: { path: "result.txt", mediaType: "text/plain" } },
    })).rejects.toThrow(/fence changed/i);
    expect(published).toBe(false);
  });
});

function dockerOk(stdout = ""): { code: number; stdout: string; stderr: string } { return { code: 0, stdout, stderr: "" }; }
function dockerMissing(): { code: number; stdout: string; stderr: string } { return { code: 1, stdout: "", stderr: "Error: No such container" }; }
