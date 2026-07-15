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
import { JsonLineRpcClient } from "@lite-harness/process-rpc";

const fixture = fileURLToPath(new URL("./fixtures/process-peer.mjs", import.meta.url));
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("process-backed extensions", () => {
  it("normalizes the official Codex app-server JSONL lifecycle", async () => {
    const gateway = new CodexAppServerGateway({
      cwd: process.cwd(),
      processFactory: (handler) => new JsonLineRpcClient(
        { command: process.execPath, args: [fixture, "codex"] },
        { onServerRequest: handler },
      ),
    });
    const events = [];
    for await (const event of gateway.streamTurn({ messages: [{ role: "user", content: "work" }] })) events.push(event);
    expect(events).toMatchObject([
      { type: "text.delta", delta: "delegated codex" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("normalizes Claude Code print-mode stream-json", async () => {
    const gateway = new ClaudeCodeGateway({
      command: process.execPath,
      commandArgsPrefix: [fixture, "claude"],
      cwd: process.cwd(),
    });
    const events = [];
    for await (const event of gateway.streamTurn({ messages: [{ role: "user", content: "work" }] })) events.push(event);
    expect(events).toMatchObject([
      { type: "text.delta", delta: "delegated claude" },
      { type: "usage", inputTokens: 4, outputTokens: 2, costUsd: 0.01 },
      { type: "completed", finishReason: "stop" },
    ]);
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

  it("locks permissions and invokes a plugin only in its worker process", async () => {
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
    expect(lock.setEnabled("example.fixture", "1.0.0", true).enabled).toBe(true);

    const worker = new LazyPluginSupervisor(() => new ProcessPluginWorker(
      { command: process.execPath, args: [fixture, "plugin"] },
      { manifest: inspected.manifest, config: {}, grants: lock.read().plugins["example.fixture@1.0.0"]!.grantedPermissions },
    ));
    await expect(worker.invoke("echo", { value: 2 })).resolves.toEqual({ action: "echo", input: { value: 2 } });
    expect(worker.active).toBe(true);
    await worker.stop();
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

    const sandbox = new DockerPluginExecutionSandbox({ image: `node@sha256:${"a".repeat(64)}` });
    const spec = sandbox.processSpec(plugin, {
      tools: ["echo"], secrets: [], events: [], files: [], networkOrigins: [],
    });
    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual(expect.arrayContaining([
      "--network", "none", "--read-only", "--cap-drop", "ALL", "no-new-privileges=true", "--user", "1000:1000",
    ]));
    expect(spec.args?.join(" ")).toContain("readonly");
    expect(spec.env).toBeUndefined();
  });
});
