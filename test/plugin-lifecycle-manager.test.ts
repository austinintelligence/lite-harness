import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { LITE_IPC_PROTOCOL_VERSION, LITE_IPC_VERSION_HEADER } from "@lite-harness/contracts";
import { RunService } from "@lite-harness/control-plane";
import {
  PluginInstallLock,
  PluginPackageInstaller,
  type InspectedPlugin,
  type PluginExecutionSandbox,
  type PluginProcessSpec,
} from "@lite-harness/plugin-core";
import { BrokeredToolRuntime, InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { ManagerPluginLifecycle } from "../apps/manager/src/plugin-lifecycle.js";
import { buildManagerServer } from "../apps/manager/src/server.js";

const roots: string[] = [];
const host = resolve(import.meta.dirname, "../packages/plugin-core/src/openclaw-host.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Manager-owned plugin lifecycle", () => {
  it("A18-MANAGER-LIFECYCLE owns inspect through uninstall, pins generations, adapts OpenClaw tools, and survives worker crashes", async () => {
    const dataDir = temporaryRoot("state");
    const officialV1 = pluginPackage("example.official", "1.0.0", "official", ["plugin_echo"], officialSource("1.0.0"));
    const officialV2 = pluginPackage("example.official", "2.0.0", "official", ["plugin_echo"], officialSource("2.0.0"));
    const compatibility = pluginPackage("example.openclaw", "1.0.0", "openclaw-compat", ["compat_echo"], `
      export default {
        register(api) {
          let active = false;
          api.registerService({
            start() { active = true; },
            health() { if (!active) throw new Error("compat service inactive"); },
            stop() { active = false; }
          });
          api.registerTool({
            name: "compat_echo",
            execute(input) { return { adapter: "openclaw-worker-v1", active, input }; }
          });
        },
        migrate(from, to) { return { migrated: true, state: { from, to }, rollbackPossible: true }; }
      };
    `);
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir,
      runtime,
      image: `sha256:${"a".repeat(64)}`,
      sandbox: new LocalProcessSandbox(),
      idleTtlMs: 0,
      rpcTimeoutMs: 1_000,
      invocationTimeoutMs: 2_000,
    });
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()));
    const manager = buildManagerServer({
      runService: service,
      internalToken: "manager-plugin-token",
      pluginLifecycle: lifecycle,
      productionReadinessChecks: async () => ({}),
    });
    const headers = {
      [LITE_IPC_VERSION_HEADER]: LITE_IPC_PROTOCOL_VERSION,
      "x-lite-internal-token": "manager-plugin-token",
    };
    try {
      expect((await manager.inject({ method: "POST", url: "/internal/plugins/inspect", payload: { path: officialV1 } })).statusCode).toBe(426);
      const inspected = await manager.inject({ method: "POST", url: "/internal/plugins/inspect", headers, payload: { path: officialV1 } });
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json()).toMatchObject({ manifest: { id: "example.official", version: "1.0.0" }, executable: true });

      const installed = await manager.inject({
        method: "POST", url: "/internal/plugins/install", headers,
        payload: { sourceRoot: officialV1, grant: { tools: ["plugin_echo"] } },
      });
      expect(installed.statusCode).toBe(200);
      expect(installed.json()).toMatchObject({ id: "example.official", version: "1.0.0", enabled: false });
      expect(runtime.listTools().map((tool) => tool.name)).not.toContain("plugin_echo");

      const enabled = await manager.inject({
        method: "POST", url: "/internal/plugins/example.official/1.0.0/enable", headers,
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ enabled: true });
      expect(runtime.listTools().map((tool) => tool.name)).toContain("plugin_echo");
      expect(lifecycle.status().plugins.find((plugin) => plugin.active)?.worker.active).toBe(false);

      await runtime.prepareRun({ runId: "run-old", workspaceId: "workspace" });
      const first = await invoke(runtime, "run-old", "plugin_echo", { value: 1 });
      expect(JSON.parse(first.content)).toMatchObject({ version: "1.0.0", input: { value: 1 } });
      await expect(invoke(runtime, "run-old", "plugin_echo", { mode: "crash" })).rejects.toThrow(/process exited/i);
      await expect(invoke(runtime, "run-old", "plugin_echo", { value: "too-soon" })).rejects.toThrow(/crash backoff/i);
      expect((await manager.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      expect(JSON.parse((await invoke(runtime, "run-old", "plugin_echo", { value: 2 })).content)).toMatchObject({ version: "1.0.0" });

      const upgraded = await manager.inject({
        method: "POST", url: "/internal/plugins/example.official/upgrade", headers,
        payload: { sourceRoot: officialV2, grant: { tools: ["plugin_echo"] } },
      });
      expect(upgraded.statusCode, upgraded.body).toBe(200);
      expect(upgraded.json()).toMatchObject({
        entry: { version: "2.0.0", enabled: true }, previousVersion: "1.0.0",
        migration: { rollbackPossible: true },
      });
      expect(JSON.parse((await invoke(runtime, "run-old", "plugin_echo", { value: "pinned" })).content)).toMatchObject({ version: "1.0.0" });
      await runtime.prepareRun({ runId: "run-new", workspaceId: "workspace" });
      expect(JSON.parse((await invoke(runtime, "run-new", "plugin_echo", { value: "new" })).content)).toMatchObject({
        version: "2.0.0", state: { migratedFrom: "1.0.0", migratedTo: "2.0.0" },
      });
      expect(lifecycle.snapshotsForRun("run-old")).toMatchObject([{ id: "example.official", version: "1.0.0" }]);
      expect(lifecycle.snapshotsForRun("run-new")).toMatchObject([{ id: "example.official", version: "2.0.0" }]);
      await lifecycle.releaseRun("run-old");
      await lifecycle.releaseRun("run-new");

      const rolledBack = await manager.inject({ method: "POST", url: "/internal/plugins/example.official/rollback", headers });
      expect(rolledBack.statusCode, rolledBack.body).toBe(200);
      expect(rolledBack.json()).toMatchObject({ version: "1.0.0", enabled: true });
      await runtime.prepareRun({ runId: "run-rollback", workspaceId: "workspace" });
      expect(JSON.parse((await invoke(runtime, "run-rollback", "plugin_echo", { value: "rollback" })).content)).toMatchObject({ version: "1.0.0" });
      const disabled = await manager.inject({ method: "POST", url: "/internal/plugins/example.official/disable", headers });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(runtime.listTools().map((tool) => tool.name)).not.toContain("plugin_echo");
      expect(JSON.parse((await invoke(runtime, "run-rollback", "plugin_echo", { value: "pinned-after-disable" })).content)).toMatchObject({
        version: "1.0.0",
      });
      await expect(lifecycle.uninstall("example.official", "1.0.0")).rejects.toThrow(/pinned by an active run/);
      await lifecycle.releaseRun("run-rollback");
      expect(lifecycle.status().plugins.filter((plugin) => plugin.id === "example.official").every((plugin) => !plugin.worker.active)).toBe(true);
      expect((await remove(manager, headers, "example.official", "2.0.0")).removed).toBe(true);
      expect((await remove(manager, headers, "example.official", "1.0.0")).removed).toBe(true);

      expect((await manager.inject({
        method: "POST", url: "/internal/plugins/install", headers,
        payload: { sourceRoot: compatibility, grant: { tools: ["compat_echo"] } },
      })).statusCode).toBe(200);
      expect((await manager.inject({
        method: "POST", url: "/internal/plugins/example.openclaw/1.0.0/enable", headers,
      })).statusCode).toBe(200);
      await runtime.prepareRun({ runId: "run-compat", workspaceId: "workspace" });
      expect(JSON.parse((await invoke(runtime, "run-compat", "compat_echo", { value: 7 })).content)).toEqual({
        adapter: "openclaw-worker-v1", active: true, input: { value: 7 },
      });
      await lifecycle.releaseRun("run-compat");
      expect((await manager.inject({ method: "POST", url: "/internal/plugins/example.openclaw/disable", headers })).statusCode).toBe(200);
      expect((await remove(manager, headers, "example.openclaw", "1.0.0")).removed).toBe(true);
      expect((await manager.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect(lifecycle.status()).toMatchObject({ plugins: [], active: [] });
    } finally {
      await manager.close();
      await service.shutdown();
      store.close();
      await lifecycle.stop();
    }
  }, 30_000);

  it("A18-INTEGRITY-COLLISION denies reserved or cross-plugin tool claims and rechecks immutable bytes at lazy start", async () => {
    const dataDir = temporaryRoot("integrity");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir,
      runtime,
      image: `sha256:${"b".repeat(64)}`,
      sandbox: new LocalProcessSandbox(),
      idleTtlMs: 0,
      rpcTimeoutMs: 1_000,
    });
    try {
      const reserved = pluginPackage("example.reserved", "1.0.0", "official", ["write_file"], officialSource("1.0.0"));
      await lifecycle.install(reserved, { tools: ["write_file"] });
      await expect(lifecycle.enable("example.reserved", "1.0.0")).rejects.toThrow(/reserved Manager capability/);
      expect(runtime.listTools().filter((tool) => tool.name === "write_file")).toHaveLength(1);
      const incompleteCompat = pluginPackage("example.incomplete-compat", "1.0.0", "openclaw-compat", ["missing_compat_tool"], `
        export default { register() {} };
      `);
      await expect(lifecycle.install(incompleteCompat, { tools: ["missing_compat_tool"] })).rejects.toThrow(/compat_tool_not_registered/);

      const first = pluginPackage("example.first", "1.0.0", "official", ["shared_plugin_tool"], officialSource("first"));
      const second = pluginPackage("example.second", "1.0.0", "official", ["shared_plugin_tool"], officialSource("second"));
      await lifecycle.install(first, { tools: ["shared_plugin_tool"] });
      await lifecycle.enable("example.first", "1.0.0");
      await lifecycle.install(second, { tools: ["shared_plugin_tool"] });
      await expect(lifecycle.enable("example.second", "1.0.0")).rejects.toThrow(/tool collision/);
      await lifecycle.disable("example.first");
      await lifecycle.uninstall("example.first", "1.0.0");
      await lifecycle.enable("example.second", "1.0.0");
      await lifecycle.disable("example.second");
      await lifecycle.uninstall("example.second", "1.0.0");

      const switchV1 = pluginPackage("example.switch", "1.0.0", "official", ["switch_tool"], officialSource("1.0.0"));
      const switchV2 = pluginPackage("example.switch", "2.0.0", "official", ["switch_tool"], officialSource("2.0.0"));
      await lifecycle.install(switchV1, { tools: ["switch_tool"] });
      await lifecycle.enable("example.switch", "1.0.0");
      await lifecycle.install(switchV2, { tools: ["switch_tool"] });
      await expect(lifecycle.enable("example.switch", "2.0.0")).rejects.toThrow(/require upgrade/);
      await lifecycle.disable("example.switch");
      await expect(lifecycle.enable("example.switch", "2.0.0")).rejects.toThrow(/only re-enable/);
      await lifecycle.enable("example.switch", "1.0.0");
      await lifecycle.disable("example.switch");
      await lifecycle.uninstall("example.switch", "2.0.0");
      await lifecycle.uninstall("example.switch", "1.0.0");

      const tampered = pluginPackage("example.tampered", "1.0.0", "official", ["tamper_tool"], officialSource("trusted"));
      await lifecycle.install(tampered, { tools: ["tamper_tool"] });
      await lifecycle.enable("example.tampered", "1.0.0");
      const lock = new PluginInstallLock(join(dataDir, "plugins.lock.json"));
      const entry = lock.read().plugins["example.tampered@1.0.0"]!;
      writeFileSync(join(entry.source, "worker.mjs"), officialSource("mutated"));
      await runtime.prepareRun({ runId: "tampered-run", workspaceId: "workspace" });
      await expect(invoke(runtime, "tampered-run", "tamper_tool", {})).rejects.toThrow(/digest mismatch/);
      expect(lifecycle.status().plugins.find((plugin) => plugin.id === "example.tampered")).toMatchObject({ healthy: false });
    } finally {
      await lifecycle.stop();
    }
  }, 20_000);

  it("A18-ORPHAN-RECONCILE removes interrupted package/state staging and can uninstall a missing inactive object", async () => {
    const dataDir = temporaryRoot("orphans");
    const staging = join(dataDir, "plugins", ".stage-interrupted");
    const object = join(dataDir, "plugins", ".objects", "c".repeat(64));
    const state = join(dataDir, "plugin-state", "orphan.plugin", "1.0.0");
    for (const path of [staging, object, state]) mkdirSync(path, { recursive: true });
    writeFileSync(join(staging, "partial"), "partial");
    writeFileSync(join(object, "partial"), "partial");
    writeFileSync(join(state, "partial.json"), "{}");
    const lock = new PluginInstallLock(join(dataDir, "plugins.lock.json"));
    const installer = new PluginPackageInstaller(join(dataDir, "plugins"), lock);
    const interruptedSource = pluginPackage("example.interrupted", "1.0.0", "official", [], officialSource("1.0.0"));
    const interrupted = lock.install(installer.stage(interruptedSource), {});
    const pendingSource = pluginPackage("example.pending", "1.0.0", "official", [], officialSource("1.0.0"));
    const pending = lock.install(installer.stage(pendingSource), {});
    lock.recordVerification(pending.id, pending.version, {
      verifiedAt: new Date().toISOString(), rollbackPossible: true, activationPending: true,
    });
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir, runtime, image: `sha256:${"d".repeat(64)}`, sandbox: new LocalProcessSandbox(), rpcTimeoutMs: 1_000,
    });
    try {
      expect([staging, object, state, interrupted.source, pending.source].map(existsSync)).toEqual([false, false, false, false, false]);
      expect(new PluginInstallLock(join(dataDir, "plugins.lock.json")).read().plugins).toEqual({});
      const unhealthy = pluginPackage("example.unhealthy", "1.0.0", "official", [], `
        export default { health() { return { ok: false }; } };
      `);
      await expect(lifecycle.install(unhealthy, {})).rejects.toThrow(/health_reported_unhealthy/);
      expect(lifecycle.status().plugins).toEqual([]);
      const source = pluginPackage("example.missing", "1.0.0", "official", ["missing_tool"], officialSource("1.0.0"));
      const installed = await lifecycle.install(source, { tools: ["missing_tool"] });
      await lifecycle.enable(installed.id, installed.version);
      await lifecycle.disable(installed.id);
      rmSync(installed.source, { recursive: true, force: true });
      await expect(lifecycle.uninstall(installed.id, installed.version)).resolves.toBe(true);
      expect(lifecycle.status().plugins).toEqual([]);
    } finally { await lifecycle.stop(); }
  }, 20_000);

  it("A18-ACTIVATION-ATOMIC releases provisional tool registrations when the durable activation write fails", async () => {
    const dataDir = temporaryRoot("activation-fault");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const lock = new FaultingPluginInstallLock(join(dataDir, "plugins.lock.json"));
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir, runtime, lock, image: `sha256:${"e".repeat(64)}`, sandbox: new LocalProcessSandbox(), rpcTimeoutMs: 1_000,
    });
    try {
      const source = pluginPackage("example.atomic", "1.0.0", "official", ["atomic_tool"], officialSource("1.0.0"));
      await lifecycle.install(source, { tools: ["atomic_tool"] });
      lock.failActivation = true;
      await expect(lifecycle.enable("example.atomic", "1.0.0")).rejects.toThrow(/injected activation write failure/);
      expect(runtime.canRegister("atomic_tool")).toBe(true);
      expect(runtime.listTools().map((tool) => tool.name)).not.toContain("atomic_tool");
      lock.failActivation = false;
      await lifecycle.enable("example.atomic", "1.0.0");
      expect(runtime.listTools().map((tool) => tool.name)).toContain("atomic_tool");
    } finally { await lifecycle.stop(); }
  }, 20_000);

  it("A18-ROLLBACK-HISTORY preserves the rollback target across disable and re-enable", async () => {
    const dataDir = temporaryRoot("rollback-history");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir, runtime, image: `sha256:${"7".repeat(64)}`, sandbox: new LocalProcessSandbox(), rpcTimeoutMs: 1_000,
    });
    const v1 = pluginPackage("example.history", "1.0.0", "official", ["history_tool"], officialSource("1.0.0"));
    const v2 = pluginPackage("example.history", "2.0.0", "official", ["history_tool"], officialSource("2.0.0"));
    try {
      await lifecycle.install(v1, { tools: ["history_tool"] });
      await lifecycle.enable("example.history", "1.0.0");
      await lifecycle.upgrade("example.history", v2, { tools: ["history_tool"] });
      await lifecycle.disable("example.history");
      const lock = new PluginInstallLock(join(dataDir, "plugins.lock.json"));
      expect(lock.read().activations?.["example.history"]).toMatchObject({
        previousVersion: "1.0.0", resumeVersion: "2.0.0",
      });
      await lifecycle.enable("example.history", "2.0.0");
      expect(lock.read().activations?.["example.history"]).toMatchObject({
        activeVersion: "2.0.0", previousVersion: "1.0.0",
      });
      expect(await lifecycle.rollback("example.history")).toMatchObject({ version: "1.0.0", enabled: true });
      await lifecycle.disable("example.history");
      await lifecycle.uninstall("example.history", "2.0.0");
      await lifecycle.uninstall("example.history", "1.0.0");
    } finally { await lifecycle.stop(); }
  }, 20_000);

  it("A18-NONREVERSIBLE-ROLLBACK rejects rollback after disabling a non-reversible migration", async () => {
    const dataDir = temporaryRoot("nonreversible-rollback");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir, runtime, image: `sha256:${"9".repeat(64)}`, sandbox: new LocalProcessSandbox(), rpcTimeoutMs: 1_000,
    });
    const v1 = pluginPackage("example.nonreversible", "1.0.0", "official", ["nonreversible_tool"], officialSource("1.0.0"));
    const v2 = pluginPackage("example.nonreversible", "2.0.0", "official", ["nonreversible_tool"], officialSource("2.0.0", false));
    try {
      await lifecycle.install(v1, { tools: ["nonreversible_tool"] });
      await lifecycle.enable("example.nonreversible", "1.0.0");
      expect((await lifecycle.upgrade("example.nonreversible", v2, { tools: ["nonreversible_tool"] })).migration)
        .toMatchObject({ rollbackPossible: false });
      await lifecycle.disable("example.nonreversible");
      await expect(lifecycle.rollback("example.nonreversible")).rejects.toThrow(/cannot be rolled back/);
    } finally { await lifecycle.stop(); }
  }, 20_000);

  it("A18-CLEANUP-BEFORE-RELEASE retries failed cleanup and retains the pinned generation until it is reaped", async () => {
    const dataDir = temporaryRoot("cleanup-retry");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const sandbox = new FailOnceCleanupSandbox();
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir, runtime, image: `sha256:${"f".repeat(64)}`, sandbox, idleTtlMs: 0, rpcTimeoutMs: 1_000,
      cleanupRetryMs: 5,
    });
    try {
      const source = pluginPackage("example.cleanup", "1.0.0", "official", ["cleanup_tool"], officialSource("1.0.0"));
      await lifecycle.install(source, { tools: ["cleanup_tool"] });
      await lifecycle.enable("example.cleanup", "1.0.0");
      await runtime.prepareRun({ runId: "cleanup-run", workspaceId: "workspace" });
      await invoke(runtime, "cleanup-run", "cleanup_tool", { value: true });
      sandbox.failNextCleanup = true;
      await lifecycle.disable("example.cleanup");
      await lifecycle.releaseRun("cleanup-run");
      expect(sandbox.cleanupAttempts).toBe(2);
      await expect(lifecycle.uninstall("example.cleanup", "1.0.0")).resolves.toBe(true);
    } finally { await lifecycle.stop(); }
  }, 20_000);

  it("A18-CLEANUP-DEBT bounds permanent cleanup failure and persists a recoverable debt", async () => {
    const dataDir = temporaryRoot("cleanup-debt");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const sandbox = new ControlledCleanupSandbox();
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir, runtime, image: `sha256:${"8".repeat(64)}`, sandbox, idleTtlMs: 0, rpcTimeoutMs: 1_000,
      cleanupRetryMs: 5, cleanupMaxAttempts: 2,
    });
    try {
      const source = pluginPackage("example.debt", "1.0.0", "official", ["debt_tool"], officialSource("1.0.0"));
      await lifecycle.install(source, { tools: ["debt_tool"] });
      await lifecycle.enable("example.debt", "1.0.0");
      await runtime.prepareRun({ runId: "debt-run", workspaceId: "workspace" });
      await invoke(runtime, "debt-run", "debt_tool", { value: true });
      await lifecycle.disable("example.debt");
      sandbox.failCleanup = true;
      await expect(lifecycle.releaseRun("debt-run")).resolves.toEqual({
        outcome: "cleanup-debt-recorded",
        cleanupDebts: [{ id: "example.debt", version: "1.0.0" }],
      });
      expect(new PluginInstallLock(join(dataDir, "plugins.lock.json")).read().cleanupDebts?.["example.debt@1.0.0"]).toMatchObject({
        id: "example.debt", version: "1.0.0", attempts: 2,
      });
      expect(sandbox.cleanupAttempts).toBeGreaterThanOrEqual(2);
      sandbox.failCleanup = false;
      await expect(lifecycle.uninstall("example.debt", "1.0.0")).resolves.toBe(true);
      expect(new PluginInstallLock(join(dataDir, "plugins.lock.json")).read().cleanupDebts).toEqual({});
    } finally { await lifecycle.stop(); }
  }, 20_000);

  it("A18-CLEANUP-DEBT-WRITE retries run release when durable debt persistence initially fails", async () => {
    const dataDir = temporaryRoot("cleanup-debt-write");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const sandbox = new ControlledCleanupSandbox();
    const lock = new FaultingCleanupDebtLock(join(dataDir, "plugins.lock.json"));
    const lifecycle = await ManagerPluginLifecycle.create({
      dataDir, runtime, lock, image: `sha256:${"6".repeat(64)}`, sandbox, idleTtlMs: 0, rpcTimeoutMs: 1_000,
      cleanupRetryMs: 5, cleanupMaxAttempts: 1,
    });
    try {
      const source = pluginPackage("example.debtwrite", "1.0.0", "official", ["debtwrite_tool"], officialSource("1.0.0"));
      await lifecycle.install(source, { tools: ["debtwrite_tool"] });
      await lifecycle.enable("example.debtwrite", "1.0.0");
      await runtime.prepareRun({ runId: "debt-write-run", workspaceId: "workspace" });
      await invoke(runtime, "debt-write-run", "debtwrite_tool", { value: true });
      await lifecycle.disable("example.debtwrite");
      sandbox.failCleanup = true;
      lock.failCleanupDebtWrites = 1;
      await expect(lifecycle.releaseRun("debt-write-run")).rejects.toThrow(/injected cleanup debt write failure/);
      expect(lock.read().cleanupDebts).toEqual({});
      sandbox.failCleanup = false;
      let removed = false;
      const deadline = Date.now() + 4_000;
      while (!removed && Date.now() < deadline) {
        try { removed = await lifecycle.uninstall("example.debtwrite", "1.0.0"); }
        catch { await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 25)); }
      }
      expect(removed).toBe(true);
    } finally { await lifecycle.stop(); }
  }, 20_000);
});

class LocalProcessSandbox implements PluginExecutionSandbox {
  processSpec(plugin: InspectedPlugin): PluginProcessSpec {
    return {
      command: process.execPath,
      args: [host],
      cwd: plugin.root,
      env: { LITE_PLUGIN_ENTRY: plugin.entryPath },
    };
  }
}

class FailOnceCleanupSandbox extends LocalProcessSandbox {
  cleanupAttempts = 0;
  failNextCleanup = false;

  override processSpec(plugin: InspectedPlugin): PluginProcessSpec {
    return {
      ...super.processSpec(plugin),
      cleanup: async () => {
        if (!this.failNextCleanup) return;
        this.cleanupAttempts += 1;
        if (this.cleanupAttempts === 1) throw new Error("injected cleanup failure");
        this.failNextCleanup = false;
      },
    };
  }
}

class ControlledCleanupSandbox extends LocalProcessSandbox {
  cleanupAttempts = 0;
  failCleanup = false;

  override processSpec(plugin: InspectedPlugin): PluginProcessSpec {
    return {
      ...super.processSpec(plugin),
      cleanup: async () => {
        if (!this.failCleanup) return;
        this.cleanupAttempts += 1;
        throw new Error("injected permanent cleanup failure");
      },
    };
  }
}

class FaultingPluginInstallLock extends PluginInstallLock {
  failActivation = false;

  override activate(id: string, version: string): ReturnType<PluginInstallLock["activate"]> {
    if (this.failActivation) throw new Error("injected activation write failure");
    return super.activate(id, version);
  }
}

class FaultingCleanupDebtLock extends PluginInstallLock {
  failCleanupDebtWrites = 0;

  override recordCleanupDebt(
    id: string,
    version: string,
    attempts: number,
    lastError: string,
  ): ReturnType<PluginInstallLock["recordCleanupDebt"]> {
    if (this.failCleanupDebtWrites > 0) {
      this.failCleanupDebtWrites -= 1;
      throw new Error("injected cleanup debt write failure");
    }
    return super.recordCleanupDebt(id, version, attempts, lastError);
  }
}

function officialSource(version: string, rollbackPossible = true): string {
  return `
    let state = {};
    export default {
      initialize({ config }) { state = config.state ?? {}; },
      invoke(action, input) {
        if (input?.mode === "crash") process.exit(23);
        if (input?.mode === "hang") return new Promise(() => {});
        return { action, input, version: "${version}", state };
      },
      migrate(from, to) {
        return { migrated: true, state: { migratedFrom: from, migratedTo: to }, rollbackPossible: ${rollbackPossible} };
      }
    };
  `;
}

function pluginPackage(id: string, version: string, trust: string, tools: string[], source: string): string {
  const root = temporaryRoot(`${id}-${version}`);
  writeFileSync(join(root, "worker.mjs"), `${source}\n`);
  writeFileSync(join(root, "lite-plugin.json"), JSON.stringify({
    schemaVersion: 1, id, version, entry: "worker.mjs", trust,
    permissions: { tools, secrets: [], events: [], files: [], networkOrigins: [] },
  }));
  return root;
}

function temporaryRoot(suffix: string): string {
  const root = mkdtempSync(join(tmpdir(), `lite-plugin-manager-${suffix}-`));
  roots.push(root);
  return root;
}

async function invoke(runtime: BrokeredToolRuntime, runId: string, name: string, args: Record<string, unknown>) {
  return await runtime.execute({
    workspaceId: "workspace", runId, allowedTools: [name],
    call: { id: `call-${runId}-${name}`, name, arguments: args },
  });
}

async function remove(
  manager: ReturnType<typeof buildManagerServer>,
  headers: Record<string, string>,
  id: string,
  version: string,
): Promise<{ removed: boolean }> {
  const response = await manager.inject({
    method: "DELETE", url: `/internal/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}`, headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { removed: boolean };
}
