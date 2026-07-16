import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerGateway, ClaudeCodeGateway } from "@lite-harness/delegated-runtime";
import { McpSupervisor, StdioMcpTransport } from "@lite-harness/mcp";
import {
  LazyPluginSupervisor,
  DockerPluginExecutionSandbox,
  PluginInstallLock,
  PluginPackageInstaller,
  ProcessPluginWorker,
  createOpenClawCompatibilityWorker,
  inspectPluginManifest,
} from "@lite-harness/plugin-core";
import { JsonLineRpcClient, type ProcessSpec } from "@lite-harness/process-rpc";
import type { ModelRunContext } from "@lite-harness/provider-core";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { createDelegatedWorkspaceResolver } from "../apps/manager/src/delegated-workspace.js";
import { shutdownManagerStages } from "../apps/manager/src/shutdown.js";

const fixture = fileURLToPath(new URL("./fixtures/process-peer.mjs", import.meta.url));
const cleanup: string[] = [];
const delegatedContext: ModelRunContext = {
  runId: "run-delegated",
  attemptId: "attempt-delegated",
  workspaceId: "workspace-delegated",
  principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
  fencingToken: 1,
};

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("process-backed extensions", () => {
  it("D26-CODEX normalizes the supervised delegated Codex app-server JSONL lifecycle", async () => {
    const gateway = new CodexAppServerGateway({
      workspacePathForRun: () => process.cwd(),
      processFactory: (handler) => new JsonLineRpcClient(
        { command: process.execPath, args: [fixture, "codex"] },
        { onServerRequest: handler },
      ),
    });
    const events = [];
    for await (const event of gateway.streamTurn({
      messages: [{ role: "user", content: "work" }], context: delegatedContext,
    })) events.push(event);
    expect(events).toMatchObject([
      { type: "text.delta", delta: "delegated codex" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("D26-CLAUDE normalizes the supervised delegated Claude Code print-mode stream-json lifecycle", async () => {
    const gateway = new ClaudeCodeGateway({
      command: process.execPath,
      commandArgsPrefix: [fixture, "claude"],
      workspacePathForRun: () => process.cwd(),
    });
    const events = [];
    for await (const event of gateway.streamTurn({
      messages: [{ role: "user", content: "work" }], context: delegatedContext,
    })) events.push(event);
    expect(events).toMatchObject([
      { type: "text.delta", delta: "delegated claude" },
      { type: "usage", inputTokens: 4, outputTokens: 2, costUsd: 0.01 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("BD-025-REGRESSION resolves the exact leased workspace for every delegated process", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "lite-delegated-workspace-"));
    cleanup.push(workspace);
    let resolvedContext: ModelRunContext | undefined;
    let processSpec: ProcessSpec | undefined;
    const gateway = new CodexAppServerGateway({
      workspacePathForRun: (context) => { resolvedContext = context; return workspace; },
      processFactory: (handler, spec) => {
        processSpec = spec;
        return new JsonLineRpcClient(
          { command: process.execPath, args: [fixture, "codex"], cwd: spec.cwd },
          { onServerRequest: handler },
        );
      },
    });
    for await (const _event of gateway.streamTurn({
      messages: [{ role: "user", content: "work in the leased directory" }], context: delegatedContext,
    })) { /* consume delegated lifecycle */ }
    expect(resolvedContext).toEqual(delegatedContext);
    expect(processSpec?.cwd).toBe(workspace);
  });

  it("rejects delegated ownership, fencing, or non-bind workspace mismatches", () => {
    const workspace = mkdtempSync(join(tmpdir(), "lite-delegated-owned-"));
    cleanup.push(workspace);
    const store = new SqliteRunStore(":memory:");
    try {
      const now = new Date().toISOString();
      store.createWorkspace({
        id: delegatedContext.workspaceId,
        appId: delegatedContext.principal.appId,
        tenantId: delegatedContext.principal.tenantId,
        userId: delegatedContext.principal.userId,
        mode: "registered-bind",
        state: "WARM",
        registeredPath: workspace,
        createdAt: now,
        updatedAt: now,
      });
      store.createOrGetRun(delegatedContext.runId, {
        agent: "coder", workspace: delegatedContext.workspaceId, input: "delegated",
        idempotencyKey: "delegated-key", principal: delegatedContext.principal,
      });
      const lease = store.acquireWorkspaceLease(delegatedContext.workspaceId, delegatedContext.runId, 60_000)!;
      const resolver = createDelegatedWorkspaceResolver(store);
      const context = { ...delegatedContext, fencingToken: lease.fencingToken };
      expect(resolver(context)).toBe(workspace);
      expect(() => resolver({ ...context, principal: { ...context.principal, userId: "other" } }))
        .toThrow(/ownership is invalid/);
      store.releaseWorkspaceLease(lease);
      expect(() => resolver(context)).toThrow(/lease is invalid or expired/);
    } finally {
      store.close();
    }
  });

  it("BD-026-REGRESSION sends the Claude transcript over stdin and never places it in argv", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "lite-claude-workspace-"));
    cleanup.push(workspace);
    const secretPrompt = "prompt-sentinel-that-must-not-appear-in-process-listings";
    let capturedSpec: ProcessSpec | undefined;
    let capturedInput: string | undefined;
    const gateway = new ClaudeCodeGateway({
      command: "claude-fixture",
      workspacePathForRun: () => workspace,
      processRunner: async (spec, options) => {
        capturedSpec = spec;
        capturedInput = options.input;
        options.onMessage({ type: "result", result: "done", usage: { input_tokens: 1, output_tokens: 1 } });
        return { code: 0, stderr: "" };
      },
    });
    for await (const _event of gateway.streamTurn({
      messages: [{ role: "user", content: secretPrompt }], context: delegatedContext,
    })) { /* consume delegated lifecycle */ }
    expect(capturedSpec?.cwd).toBe(workspace);
    expect(capturedSpec?.args?.join(" ")).not.toContain(secretPrompt);
    expect(capturedInput).toContain(secretPrompt);
  });

  it("supervises a filtered MCP stdio worker", async () => {
    const supervisor = new McpSupervisor({ idleTtlMs: 10 });
    supervisor.register("fixture", () => new StdioMcpTransport({
      command: process.execPath, args: [fixture, "mcp"],
    }), { include: ["safe.*"] });
    expect((await supervisor.listTools("fixture")).map((tool) => tool.name)).toEqual(["safe.echo"]);
    await expect(supervisor.call("fixture", "safe.echo", { value: 1 })).resolves.toMatchObject({ content: expect.any(Array) });
    await expect(supervisor.call("fixture", "denied.tool", {})).rejects.toThrow(/denied by policy/);
    await supervisor.stopAll();
  });

  it("D25 A22-HOST-PLUGIN-IDLE-ZERO locks permissions, invokes in one worker process, and reaps it after idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-plugin-"));
    cleanup.push(root);
    const entry = join(root, "dist", "worker.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "// fixture");
    writeFileSync(join(root, "lite.plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "example.fixture",
      version: "1.0.0",
      entry: "dist/worker.js",
      trust: "isolated",
      permissions: { tools: ["echo", "admin"], secrets: [], events: [], files: [], networkOrigins: [] },
    }));
    const inspected = inspectPluginManifest(join(root, "lite.plugin.json"));
    const lock = new PluginInstallLock(join(root, "installed.lock.json"));
    expect(lock.install(inspected, { tools: ["echo"] }).grantedPermissions.tools).toEqual(["echo"]);
    lock.recordVerification("example.fixture", "1.0.0", {
      verifiedAt: new Date().toISOString(),
      rollbackPossible: true,
    });
    expect(lock.setEnabled("example.fixture", "1.0.0", true).enabled).toBe(true);

    const processResourcesBefore = process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length;
    const worker = new LazyPluginSupervisor(() => new ProcessPluginWorker(
      { command: process.execPath, args: [fixture, "plugin"] },
      { manifest: inspected.manifest, config: {}, grants: lock.read().plugins["example.fixture@1.0.0"]!.grantedPermissions },
    ), { idleTtlMs: 25 });
    await expect(worker.invoke("echo", { value: 2 })).resolves.toEqual({ action: "echo", input: { value: 2 } });
    expect(worker.active).toBe(true);
    await waitForCondition(() => !worker.active, 2_000, "Timed out waiting for plugin idle cleanup");
    expect(worker.active).toBe(false);
    expect(process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length).toBeLessThanOrEqual(processResourcesBefore);
    await worker.stop();
  });

  it.each(["plugin-initialize-error", "plugin-health-error"])(
    "A22-PLUGIN-START-FAILURE-REAP reaps the process and cleanup handle after %s",
    async (mode) => {
      const processResourcesBefore = process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length;
      let cleanups = 0;
      const worker = new ProcessPluginWorker(
        { command: process.execPath, args: [fixture, mode], cleanup: async () => { cleanups += 1; } },
        {
          manifest: {
            schemaVersion: 1, id: "example.failure", version: "1.0.0", entry: "worker.mjs", trust: "isolated",
            permissions: { tools: [], secrets: [], events: [], files: [], networkOrigins: [] },
          },
          config: {},
          grants: { tools: [], secrets: [], events: [], files: [], networkOrigins: [] },
        },
      );
      await expect(worker.start()).rejects.toThrow(/fixture (?:initialize|health) failed/);
      expect(cleanups).toBe(1);
      await waitForProcessWrapCount(processResourcesBefore);
      expect(process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length)
        .toBeLessThanOrEqual(processResourcesBefore);
    },
  );

  it("A22-PLUGIN-CLEANUP-RETRY keeps a failed Docker reap poisoned until shutdown retries it", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-plugin-cleanup-retry-"));
    cleanup.push(root);
    writeFileSync(join(root, "worker.mjs"), "export default {};\n");
    writeFileSync(join(root, "lite-plugin.json"), JSON.stringify({
      schemaVersion: 1, id: "example.cleanup-retry", version: "1.0.0", entry: "worker.mjs", trust: "isolated",
      permissions: { tools: ["echo"], secrets: [], events: [], files: [], networkOrigins: [] },
    }));
    const plugin = inspectPluginManifest(join(root, "lite-plugin.json"));
    const commands: string[][] = [];
    let exists = true;
    let running = true;
    let failFirstInspect = true;
    const sandbox = new DockerPluginExecutionSandbox({
      image: `sha256:${"a".repeat(64)}`,
      installationId: "cleanup-retry-test",
      cleanupRunner: async (args) => {
        commands.push([...args]);
        if (args[0] === "container" && args[1] === "inspect") {
          if (failFirstInspect) {
            failFirstInspect = false;
            return { code: 1, stdout: "", stderr: "temporary Docker daemon failure" };
          }
          if (!exists) return { code: 1, stdout: "", stderr: "No such container" };
          return { code: 0, stdout: args.includes("--format") ? `${running}|${running ? "running" : "exited"}` : "{}", stderr: "" };
        }
        if (args[0] === "container" && args[1] === "kill") { running = false; return { code: 0, stdout: "killed", stderr: "" }; }
        if (args[0] === "container" && args[1] === "wait") return { code: 0, stdout: "137", stderr: "" };
        if (args[0] === "container" && args[1] === "rm") { exists = false; return { code: 0, stdout: "removed", stderr: "" }; }
        throw new Error(`Unexpected Docker cleanup command: ${args.join(" ")}`);
      },
    });
    const spec = sandbox.processSpec(plugin, { tools: ["echo"], secrets: [], events: [], files: [], networkOrigins: [] });
    let invocations = 0;
    let reportCleanupFailure!: () => void;
    const cleanupFailed = new Promise<void>((resolve) => { reportCleanupFailure = resolve; });
    const supervisor = new LazyPluginSupervisor(() => ({
      start: async () => undefined,
      invoke: async () => { invocations += 1; return "ok"; },
      stop: async () => { await spec.cleanup?.(); },
    }), {
      idleTtlMs: 10,
      cleanupRetryMs: 60_000,
      onCleanupError: () => reportCleanupFailure(),
    });

    await expect(supervisor.invoke("echo", {})).resolves.toBe("ok");
    await cleanupFailed;
    expect({ active: supervisor.active, cleanupPending: supervisor.cleanupPending, exists }).toEqual({ active: true, cleanupPending: true, exists: true });
    await expect(supervisor.invoke("must-not-run", {})).rejects.toThrow(/cleanup is pending/);
    expect(invocations).toBe(1);
    await supervisor.stop();
    expect({ active: supervisor.active, cleanupPending: supervisor.cleanupPending, exists }).toEqual({ active: false, cleanupPending: false, exists: false });
    expect(commands.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "container inspect", "container inspect", "container kill", "container wait", "container rm", "container inspect",
    ]);
  });

  it("keeps startup Docker commands independent from the shorter cleanup budget", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-plugin-command-timeout-"));
    cleanup.push(root);
    writeFileSync(join(root, "ps"), "setTimeout(() => process.exit(0), 3000);\n");
    const helper = join(root, "timeout-repro.mts");
    const pluginCore = new URL("../packages/plugin-core/src/index.ts", import.meta.url).href;
    writeFileSync(helper, `
      import { DockerPluginExecutionSandbox } from ${JSON.stringify(pluginCore)};
      process.chdir(${JSON.stringify(root)});
      const sandbox = new DockerPluginExecutionSandbox({
        image: "sha256:${"a".repeat(64)}",
        installationId: "configured-command-timeout",
        dockerCommand: process.execPath,
        cleanupTimeoutMs: 1000,
      });
      const started = Date.now();
      try {
        const reaped = await sandbox.reconcileContainers();
        process.stdout.write(JSON.stringify({ reaped, elapsedMs: Date.now() - started }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ message: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started }));
        process.exitCode = 2;
      }
    `);
    const result = spawnSync(process.execPath, ["--import", "tsx", helper], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 7_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { reaped: number; elapsedMs: number };
    expect(output.reaped).toBe(0);
    expect(output.elapsedMs).toBeGreaterThanOrEqual(2_800);
    expect(output.elapsedMs).toBeLessThan(5_000);
  });

  it("A22-MANAGER-SHUTDOWN-CONTINUES retries poisoned plugin cleanup after an earlier stage fails", async () => {
    let stopAttempts = 0;
    let reportCleanupFailure!: () => void;
    const cleanupFailed = new Promise<void>((resolve) => { reportCleanupFailure = resolve; });
    const supervisor = new LazyPluginSupervisor(() => ({
      start: async () => undefined,
      invoke: async () => "ok",
      stop: async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("transient plugin cleanup failure");
      },
    }), {
      idleTtlMs: 10,
      cleanupRetryMs: 60_000,
      onCleanupError: () => reportCleanupFailure(),
    });
    await supervisor.invoke("echo", {});
    await cleanupFailed;
    expect(supervisor.cleanupPending).toBe(true);

    const order: string[] = [];
    let shutdownError: unknown;
    try {
      await shutdownManagerStages([
        { name: "automation", stop: () => { order.push("automation"); } },
        { name: "run-service", stop: () => { order.push("run-service"); throw new Error("service shutdown failed"); } },
        { name: "brokered-capabilities", stop: () => { order.push("brokered-capabilities"); } },
        { name: "optional-systems", stop: async () => { order.push("optional-systems"); await supervisor.stop(); } },
        { name: "run-store", stop: () => { order.push("run-store"); } },
        { name: "instance-lock", stop: () => { order.push("instance-lock"); } },
      ]);
    } catch (error) { shutdownError = error; }

    expect(shutdownError).toBeInstanceOf(AggregateError);
    expect((shutdownError as AggregateError).errors).toHaveLength(1);
    expect((shutdownError as Error).message).toMatch(/cleanup failures/);
    expect(order).toEqual(["automation", "run-service", "brokered-capabilities", "optional-systems", "run-store", "instance-lock"]);
    expect({ active: supervisor.active, cleanupPending: supervisor.cleanupPending, stopAttempts }).toEqual({ active: false, cleanupPending: false, stopAttempts: 2 });
  });

  it("BD-007-REGRESSION rejects a plugin version before it can escape install or uninstall roots", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-plugin-version-"));
    cleanup.push(root);
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "worker.mjs"), "export default {};\n");
    writeFileSync(join(source, "lite-plugin.json"), JSON.stringify({
      schemaVersion: 1, id: "example.escape", version: "../../escaped", entry: "worker.mjs", trust: "isolated",
      permissions: { tools: [], secrets: [], events: [], files: [], networkOrigins: [] },
    }));
    const installer = new PluginPackageInstaller(
      join(root, "installed"),
      new PluginInstallLock(join(root, "state", "plugins.json")),
    );
    expect(() => installer.stage(source)).toThrow(/version.*invalid/i);
    expect(() => installer.uninstall("example.escape", "../../escaped")).toThrow(/version.*invalid/i);
  });

  it("BD-008-REGRESSION denies executable plugins unless an enforceable sandbox is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-compat-plugin-"));
    cleanup.push(root);
    writeFileSync(join(root, "worker.mjs"), `export default {
      invoke(action, input) { return { action, input, pid: process.pid }; },
      migrate(from, to) { return { from, to }; }
    };\n`);
    writeFileSync(join(root, "lite-plugin.json"), JSON.stringify({
      schemaVersion: 1, id: "example.compat", version: "1.0.0", entry: "worker.mjs", trust: "openclaw-compat",
      permissions: { tools: ["echo"], secrets: [], events: [], files: [], networkOrigins: [] },
    }));
    const plugin = inspectPluginManifest(join(root, "lite-plugin.json"));
    const worker = createOpenClawCompatibilityWorker(plugin, {
      tools: ["echo"], secrets: [], events: [], files: [], networkOrigins: [],
    });
    try {
      await expect(worker.invoke("echo", { value: 1 })).rejects.toThrow(/denied.*sandbox/i);
    } finally { await worker.stop(); }

    const sandbox = new DockerPluginExecutionSandbox({
      image: `node@sha256:${"a".repeat(64)}`,
      installationId: "process-extension-test",
    });
    const spec = sandbox.processSpec(plugin, {
      tools: ["echo"], secrets: [], events: [], files: [], networkOrigins: [],
    });
    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual(expect.arrayContaining([
      "--pull=never", "--name", expect.stringMatching(/^lite-harness-plugin-/),
      "lite-harness.managed=true", "lite-harness.component=plugin",
      "--network", "none", "--read-only", "--cap-drop", "ALL", "no-new-privileges=true", "--user", "1000:1000",
    ]));
    expect(spec.args).not.toContain("--rm");
    expect(spec.args?.join(" ")).toContain("readonly");
    expect(spec.env).toBeUndefined();
  });
});

async function waitForProcessWrapCount(maximum: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length > maximum) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for plugin process reap");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
