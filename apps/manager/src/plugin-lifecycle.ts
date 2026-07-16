import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "@lite-harness/contracts";
import {
  createOpenClawCompatibilityWorker,
  DockerPluginExecutionSandbox,
  inspectLockedPlugin,
  inspectPluginManifest,
  LazyPluginSupervisor,
  PluginInstallLock,
  PluginPackageInstaller,
  pluginPackageDigest,
  type ExecutablePluginWorker,
  type InspectedPlugin,
  type PluginExecutionSandbox,
  type PluginLockEntry,
  type PluginPermissions,
} from "@lite-harness/plugin-core";
import { type BrokeredToolRuntime, type ToolExecutionContext, type ToolListContext } from "@lite-harness/runtime";

export interface PluginInspectionReport {
  manifest: InspectedPlugin["manifest"];
  digest: string;
  executable: boolean;
  compatibility: {
    adapter: "none" | "openclaw-worker-v1";
    supported: readonly string[];
    unsupported: readonly string[];
  };
}

export interface PluginLifecycleRecord {
  id: string;
  version: string;
  digest: string;
  trust: PluginLockEntry["trust"];
  enabled: boolean;
  active: boolean;
  previous: boolean;
  resume: boolean;
  verifiedAt?: string;
  stateDigest?: string;
  healthy: boolean;
  error?: string;
  cleanupDebt?: { attempts: number; updatedAt: string; lastError: string };
  worker: { active: boolean; cleanupPending: boolean; startCount: number };
}

export interface PluginLifecycleStatus {
  plugins: PluginLifecycleRecord[];
  active: Array<{ id: string; version: string; digest: string }>;
}

export type PluginRunReleaseResult =
  | { outcome: "released"; cleanupDebts: [] }
  | { outcome: "cleanup-debt-recorded"; cleanupDebts: Array<{ id: string; version: string }> };

export interface PluginLifecyclePort {
  inspect(path: string): PluginInspectionReport;
  status(): PluginLifecycleStatus;
  install(sourceRoot: string, grant: Partial<PluginPermissions>): Promise<PluginLockEntry>;
  enable(id: string, version: string): Promise<PluginLockEntry>;
  upgrade(id: string, sourceRoot: string, grant: Partial<PluginPermissions>): Promise<{
    entry: PluginLockEntry;
    previousVersion: string;
    migration: { stateDigest: string; rollbackPossible: boolean };
  }>;
  rollback(id: string): Promise<PluginLockEntry>;
  disable(id: string, expectedVersion?: string): Promise<PluginLockEntry>;
  uninstall(id: string, version: string): Promise<boolean>;
  snapshotsForRun(runId: string): Array<{ id: string; version: string; digest: string }>;
  releaseRun(runId: string): Promise<PluginRunReleaseResult>;
  stop(): Promise<void>;
}

interface ManagedPluginSandbox extends PluginExecutionSandbox {
  reconcileContainers?(): Promise<number>;
}

interface PluginGeneration {
  id: string;
  version: string;
  supervisor?: LazyPluginSupervisor;
}

interface RegisteredPluginTool {
  pluginId: string;
  dispose: () => void;
}

const DEFAULT_RESERVED_TOOL_NAMES = Object.freeze([
  "artifact_publish",
  "app_callback",
  "browser_action",
  "browser_close",
  "browser_open",
  "cache_resolve",
  "context_fetch_exact",
  "memory_add",
  "memory_get",
  "memory_search",
  "read_file",
  "skill_list",
  "skill_view",
  "subagent_cancel",
  "subagent_spawn",
  "subagent_wait",
  "write_file",
]);

export class ManagerPluginLifecycle implements PluginLifecyclePort {
  readonly #lock: PluginInstallLock;
  readonly #installer: PluginPackageInstaller;
  readonly #sandbox: ManagedPluginSandbox;
  readonly #stateRoot: string;
  readonly #active = new Map<string, string>();
  readonly #previous = new Map<string, string>();
  readonly #resume = new Map<string, string>();
  readonly #generations = new Map<string, PluginGeneration>();
  readonly #registeredTools = new Map<string, RegisteredPluginTool>();
  readonly #runPins = new Map<string, Map<string, string>>();
  readonly #cleanupRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #releaseRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reservedTools: Set<string>;
  readonly #removeRunPreparer: () => void;
  #operationTail: Promise<void> = Promise.resolve();
  #stopped = false;

  private constructor(private readonly options: {
    dataDir: string;
    runtime: BrokeredToolRuntime;
    image: string;
    lock?: PluginInstallLock;
    installationId?: string;
    sandbox?: ManagedPluginSandbox;
    idleTtlMs?: number;
    rpcTimeoutMs?: number;
    invocationTimeoutMs?: number;
    cleanupRetryMs?: number;
    cleanupMaxAttempts?: number;
    cleanupTimeoutMs?: number;
    crashBackoffBaseMs?: number;
    crashBackoffMaxMs?: number;
    reservedToolNames?: readonly string[];
  }) {
    const pluginRoot = join(options.dataDir, "plugins");
    this.#stateRoot = join(options.dataDir, "plugin-state");
    this.#lock = options.lock ?? new PluginInstallLock(join(options.dataDir, "plugins.lock.json"));
    this.#installer = new PluginPackageInstaller(pluginRoot, this.#lock);
    this.#sandbox = options.sandbox ?? new DockerPluginExecutionSandbox({
      image: options.image,
      installationId: options.installationId ?? options.dataDir,
      cleanupTimeoutMs: options.cleanupTimeoutMs ?? 5_000,
    });
    this.#reservedTools = new Set([...DEFAULT_RESERVED_TOOL_NAMES, ...(options.reservedToolNames ?? [])]);
    this.#removeRunPreparer = options.runtime.addRunPreparer(({ runId }) => { this.#pinRun(runId); });
  }

  static async create(options: {
    dataDir: string;
    runtime: BrokeredToolRuntime;
    image: string;
    lock?: PluginInstallLock;
    installationId?: string;
    sandbox?: ManagedPluginSandbox;
    idleTtlMs?: number;
    rpcTimeoutMs?: number;
    invocationTimeoutMs?: number;
    cleanupRetryMs?: number;
    cleanupMaxAttempts?: number;
    cleanupTimeoutMs?: number;
    crashBackoffBaseMs?: number;
    crashBackoffMaxMs?: number;
    reservedToolNames?: readonly string[];
  }): Promise<ManagerPluginLifecycle> {
    const lifecycle = new ManagerPluginLifecycle(options);
    try {
      const reaped = await lifecycle.#sandbox.reconcileContainers?.() ?? 0;
      if (reaped > 0) process.stderr.write(`lite-harness manager: reaped ${reaped} interrupted plugin container(s)\n`);
      lifecycle.#lock.clearAllCleanupDebts();
      lifecycle.#reconcileInterruptedInstalls();
      lifecycle.#installer.reconcileOrphans();
      lifecycle.#reconcileStateSnapshots();
      lifecycle.#loadActiveGenerations();
      return lifecycle;
    } catch (error) {
      lifecycle.#removeRunPreparer();
      throw error;
    }
  }

  inspect(path: string): PluginInspectionReport {
    this.#assertRunning();
    const metadata = statSync(path);
    const manifestPath = metadata.isDirectory() ? join(path, "lite-plugin.json") : path;
    const inspected = inspectPluginManifest(manifestPath);
    return {
      manifest: structuredClone(inspected.manifest),
      digest: pluginPackageDigest(inspected),
      executable: inspected.manifest.trust !== "data-only",
      compatibility: inspected.manifest.trust === "openclaw-compat"
        ? {
            adapter: "openclaw-worker-v1",
            supported: ["registerTool", "registerService", "invoke", "health", "migrate", "shutdown"],
            unsupported: ["gateway routes", "internal SDK imports", "global mutation", "host commands", "unbounded hooks"],
          }
        : { adapter: "none", supported: [], unsupported: [] },
    };
  }

  status(): PluginLifecycleStatus {
    this.#assertRunning();
    const lock = this.#lock.read();
    const plugins = Object.values(lock.plugins).map((entry): PluginLifecycleRecord => {
      let healthy = false;
      let error: string | undefined;
      try { inspectLockedPlugin(entry); healthy = true; }
      catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      const generation = this.#generations.get(pluginKey(entry.id, entry.version));
      const cleanupDebt = lock.cleanupDebts?.[pluginKey(entry.id, entry.version)];
      return {
        id: entry.id,
        version: entry.version,
        digest: entry.digest,
        trust: entry.trust,
        enabled: entry.enabled,
        active: this.#active.get(entry.id) === entry.version,
        previous: this.#previous.get(entry.id) === entry.version,
        resume: this.#resume.get(entry.id) === entry.version,
        ...(entry.verifiedAt ? { verifiedAt: entry.verifiedAt } : {}),
        ...(entry.stateDigest ? { stateDigest: entry.stateDigest } : {}),
        healthy,
        ...(error ? { error } : {}),
        ...(cleanupDebt ? { cleanupDebt: {
          attempts: cleanupDebt.attempts,
          updatedAt: cleanupDebt.updatedAt,
          lastError: cleanupDebt.lastError,
        } } : {}),
        worker: {
          active: generation?.supervisor?.active ?? false,
          cleanupPending: generation?.supervisor?.cleanupPending ?? false,
          startCount: generation?.supervisor?.startCount ?? 0,
        },
      };
    }).sort((left, right) => pluginKey(left.id, left.version).localeCompare(pluginKey(right.id, right.version)));
    return { plugins, active: this.#activeSnapshots() };
  }

  install(sourceRoot: string, grant: Partial<PluginPermissions>): Promise<PluginLockEntry> {
    return this.#exclusive(async () => {
      const staged = this.#installer.stage(sourceRoot);
      let entry: PluginLockEntry | undefined;
      try {
        entry = this.#lock.install(staged, grant);
        const stateDigest = this.#writeState(entry.id, entry.version, {});
        await this.#verify(entry, {});
        return this.#lock.recordVerification(entry.id, entry.version, {
          verifiedAt: new Date().toISOString(), stateDigest, rollbackPossible: true,
        });
      } catch (error) {
        if (entry) this.#lock.uninstall(entry.id, entry.version);
        rmSync(staged.root, { recursive: true, force: true });
        rmSync(join(this.#stateRoot, staged.manifest.id, staged.manifest.version), { recursive: true, force: true });
        throw error;
      }
    });
  }

  enable(id: string, version: string): Promise<PluginLockEntry> {
    return this.#exclusive(async () => {
      const activation = this.#lock.read().activations?.[id];
      if (activation?.activeVersion && activation.activeVersion !== version) {
        throw new Error(`Plugin generation changes require upgrade: ${id}@${activation.activeVersion} -> ${version}`);
      }
      if (!activation?.activeVersion && activation?.resumeVersion && activation.resumeVersion !== version) {
        throw new Error(`Plugin can only re-enable its disabled generation: ${id}@${activation.resumeVersion}`);
      }
      let entry = this.#requiredEntry(id, version);
      if (this.#lock.read().cleanupDebts?.[pluginKey(id, version)]) {
        throw new Error(`Plugin cleanup is still pending: ${id}@${version}`);
      }
      if (entry.installState === "staging" || entry.installState === "activation-pending") {
        throw new Error(`Plugin verification is incomplete: ${id}@${version}`);
      }
      const state = this.#readState(entry);
      if (!entry.verifiedAt) {
        await this.#verify(entry, state);
        entry = this.#lock.recordVerification(id, version, {
          verifiedAt: new Date().toISOString(),
          ...(entry.stateDigest ? { stateDigest: entry.stateDigest } : {}),
          rollbackPossible: entry.rollbackPossible ?? true,
        });
      } else inspectLockedPlugin(entry);
      const createdTools = this.#ensureToolRegistrations(entry);
      if (activation?.activeVersion === version) return entry;
      try {
        const switched = this.#lock.activate(id, version);
        this.#applyActivation(
          id, switched.activation.activeVersion, switched.activation.previousVersion, switched.activation.resumeVersion,
        );
        return switched.entry;
      } catch (error) {
        this.#disposeToolRegistrations(createdTools);
        throw error;
      }
    });
  }

  upgrade(id: string, sourceRoot: string, grant: Partial<PluginPermissions>): Promise<{
    entry: PluginLockEntry;
    previousVersion: string;
    migration: { stateDigest: string; rollbackPossible: boolean };
  }> {
    return this.#exclusive(async () => {
      const previousVersion = this.#active.get(id);
      if (!previousVersion) throw new Error(`Plugin is not enabled: ${id}`);
      const previousEntry = this.#requiredEntry(id, previousVersion);
      const staged = this.#installer.stage(sourceRoot);
      let candidate: PluginLockEntry | undefined;
      let createdTools: string[] = [];
      try {
        if (staged.manifest.id !== id) throw new Error(`Plugin upgrade identity mismatch: expected ${id}`);
        if (staged.manifest.version === previousVersion) throw new Error("Plugin upgrade requires a new version");
        candidate = this.#lock.install(staged, grant);
        const migration = await this.#migrate(candidate, previousEntry, this.#readState(previousEntry));
        const stateDigest = this.#writeState(candidate.id, candidate.version, migration.state);
        await this.#verify(candidate, migration.state);
        candidate = this.#lock.recordVerification(candidate.id, candidate.version, {
          verifiedAt: new Date().toISOString(), stateDigest, rollbackPossible: migration.rollbackPossible,
          activationPending: true,
        });
        createdTools = this.#ensureToolRegistrations(candidate);
        const switched = this.#lock.activate(candidate.id, candidate.version);
        this.#applyActivation(
          candidate.id, switched.activation.activeVersion, switched.activation.previousVersion, switched.activation.resumeVersion,
        );
        return {
          entry: switched.entry,
          previousVersion,
          migration: { stateDigest, rollbackPossible: migration.rollbackPossible },
        };
      } catch (error) {
        this.#disposeToolRegistrations(createdTools);
        if (candidate && this.#active.get(candidate.id) !== candidate.version) {
          await this.#stopGeneration(candidate.id, candidate.version).catch(() => undefined);
          this.#installer.uninstall(candidate.id, candidate.version);
          this.#generations.delete(pluginKey(candidate.id, candidate.version));
          rmSync(join(this.#stateRoot, candidate.id, candidate.version), { recursive: true, force: true });
          this.#pruneToolRegistrations(candidate.id);
        } else if (!candidate) {
          rmSync(staged.root, { recursive: true, force: true });
        }
        throw error;
      }
    });
  }

  rollback(id: string): Promise<PluginLockEntry> {
    return this.#exclusive(async () => {
      const activation = this.#lock.read().activations?.[id];
      if (!activation?.previousVersion) throw new Error(`Plugin has no rollback generation: ${id}`);
      const currentVersion = activation.activeVersion ?? activation.resumeVersion;
      const current = currentVersion ? this.#requiredEntry(id, currentVersion) : undefined;
      if (current?.rollbackPossible === false) throw new Error(`Plugin migration cannot be rolled back: ${id}@${current.version}`);
      const target = this.#requiredEntry(id, activation.previousVersion);
      if (this.#lock.read().cleanupDebts?.[pluginKey(id, target.version)]) {
        throw new Error(`Plugin cleanup is still pending: ${id}@${target.version}`);
      }
      if (target.installState === "staging" || target.installState === "activation-pending") {
        throw new Error(`Plugin verification is incomplete: ${id}@${target.version}`);
      }
      await this.#verify(target, this.#readState(target));
      const createdTools = this.#ensureToolRegistrations(target);
      try {
        const switched = this.#lock.rollback(id);
        this.#applyActivation(
          id, switched.activation.activeVersion, switched.activation.previousVersion, switched.activation.resumeVersion,
        );
        return switched.entry;
      } catch (error) {
        this.#disposeToolRegistrations(createdTools);
        throw error;
      }
    });
  }

  disable(id: string, expectedVersion?: string): Promise<PluginLockEntry> {
    return this.#exclusive(async () => {
      if (expectedVersion && this.#active.get(id) !== expectedVersion) {
        throw new Error(`Plugin active generation changed: expected ${id}@${expectedVersion}`);
      }
      const disabled = this.#lock.disable(id);
      this.#applyActivation(
        id, disabled.activation.activeVersion, disabled.activation.previousVersion, disabled.activation.resumeVersion,
      );
      const failures = await this.#stopUnpinnedPluginGenerations(id);
      for (const failure of failures) this.#recordCleanupDebt(failure.id, failure.version, failure.error);
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.error),
          `Plugin ${id} was disabled with durable cleanup debt`,
        );
      }
      return disabled.entry;
    });
  }

  uninstall(id: string, version: string): Promise<boolean> {
    return this.#exclusive(async () => {
      if (this.#active.get(id) === version) throw new Error(`Cannot uninstall active plugin generation: ${id}@${version}`);
      if ([...this.#runPins.values()].some((pins) => pins.get(id) === version)) {
        throw new Error(`Cannot uninstall plugin generation pinned by an active run: ${id}@${version}`);
      }
      await this.#stopGeneration(id, version);
      this.#lock.clearCleanupDebt(id, version);
      const removed = this.#installer.uninstall(id, version);
      if (removed) {
        this.#generations.delete(pluginKey(id, version));
        rmSync(join(this.#stateRoot, id, version), { recursive: true, force: true });
        if (this.#previous.get(id) === version) this.#previous.delete(id);
        if (this.#resume.get(id) === version) this.#resume.delete(id);
        this.#pruneToolRegistrations(id);
      }
      return removed;
    });
  }

  snapshotsForRun(runId: string): Array<{ id: string; version: string; digest: string }> {
    this.#assertRunning();
    const pins = this.#runPins.get(runId) ?? this.#pinRun(runId);
    const lock = this.#lock.read();
    return [...pins].map(([id, version]) => {
      const entry = lock.plugins[pluginKey(id, version)];
      if (!entry) throw new Error(`Pinned plugin generation disappeared: ${id}@${version}`);
      return { id, version, digest: entry.digest };
    }).sort((left, right) => pluginKey(left.id, left.version).localeCompare(pluginKey(right.id, right.version)));
  }

  releaseRun(runId: string): Promise<PluginRunReleaseResult> {
    return this.#exclusive(async (): Promise<PluginRunReleaseResult> => {
      const pins = this.#runPins.get(runId);
      if (!pins) return { outcome: "released", cleanupDebts: [] };
      const failures: Array<{ id: string; version: string; error: unknown }> = [];
      for (const [id, version] of pins) {
        const pinnedElsewhere = [...this.#runPins].some(
          ([candidateRunId, candidate]) => candidateRunId !== runId && candidate.get(id) === version,
        );
        if (this.#active.get(id) === version || pinnedElsewhere) continue;
        const failure = await this.#stopGenerationWithBudget(id, version);
        if (failure) failures.push({ id, version, error: failure });
      }
      for (const failure of failures) this.#recordCleanupDebt(failure.id, failure.version, failure.error);
      this.#runPins.delete(runId);
      if (failures.length > 0) {
        return {
          outcome: "cleanup-debt-recorded",
          cleanupDebts: failures.map(({ id, version }) => ({ id, version })),
        };
      }
      return { outcome: "released", cleanupDebts: [] };
    }).catch((error) => {
      this.#scheduleRunReleaseRetry(runId);
      throw error;
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#removeRunPreparer();
    this.#runPins.clear();
    for (const timer of this.#cleanupRetryTimers.values()) clearTimeout(timer);
    this.#cleanupRetryTimers.clear();
    for (const timer of this.#releaseRetryTimers.values()) clearTimeout(timer);
    this.#releaseRetryTimers.clear();
    const generations = [...this.#generations.values()];
    const results = await Promise.allSettled(generations.map((generation) => generation.supervisor?.stop()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    results.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const generation = generations[index];
      if (generation) this.#lock.recordCleanupDebt(generation.id, generation.version, 1, cleanupErrorMessage(result.reason));
    });
    for (const registration of this.#registeredTools.values()) registration.dispose();
    this.#registeredTools.clear();
    if (failures.length > 0) throw new AggregateError(failures, "One or more plugin generations failed to stop");
  }

  #loadActiveGenerations(): void {
    const lock = this.#lock.read();
    for (const [id, activation] of Object.entries(lock.activations ?? {})) {
      if (activation.activeVersion) this.#active.set(id, activation.activeVersion);
      if (activation.previousVersion) this.#previous.set(id, activation.previousVersion);
      if (activation.resumeVersion) this.#resume.set(id, activation.resumeVersion);
    }
    const activeEntries = [...this.#active].map(([id, version]) => this.#requiredEntry(id, version));
    for (const entry of activeEntries) inspectLockedPlugin(entry);
    this.#validateToolRegistrations(activeEntries);
    for (const entry of activeEntries) this.#ensureToolRegistrations(entry);
  }

  #reconcileInterruptedInstalls(): void {
    const interrupted = Object.values(this.#lock.read().plugins)
      .filter((entry) => entry.installState === "staging" || entry.installState === "activation-pending");
    for (const entry of interrupted) {
      this.#installer.uninstall(entry.id, entry.version);
      rmSync(join(this.#stateRoot, entry.id, entry.version), { recursive: true, force: true });
    }
  }

  #reconcileStateSnapshots(): void {
    if (!existsSync(this.#stateRoot)) return;
    const lock = this.#lock.read();
    for (const idEntry of readdirSync(this.#stateRoot, { withFileTypes: true })) {
      const idPath = join(this.#stateRoot, idEntry.name);
      if (!idEntry.isDirectory()) { rmSync(idPath, { recursive: true, force: true }); continue; }
      for (const versionEntry of readdirSync(idPath, { withFileTypes: true })) {
        const versionPath = join(idPath, versionEntry.name);
        const installed = lock.plugins[pluginKey(idEntry.name, versionEntry.name)];
        if (!versionEntry.isDirectory() || !installed) {
          rmSync(versionPath, { recursive: true, force: true });
          continue;
        }
        const retained = installed.stateDigest ? `${installed.stateDigest}.json` : undefined;
        for (const snapshot of readdirSync(versionPath, { withFileTypes: true })) {
          if (snapshot.isFile() && snapshot.name === retained) continue;
          rmSync(join(versionPath, snapshot.name), { recursive: true, force: true });
        }
      }
    }
  }

  #pinRun(runId: string): Map<string, string> {
    const existing = this.#runPins.get(runId);
    if (existing) return existing;
    const pinned = new Map(this.#active);
    this.#runPins.set(runId, pinned);
    return pinned;
  }

  #resolveVersion(pluginId: string, context?: ToolListContext): string | undefined {
    return context?.runId ? this.#pinRun(context.runId).get(pluginId) : this.#active.get(pluginId);
  }

  #ensureToolRegistrations(entry: PluginLockEntry): string[] {
    if (entry.trust === "data-only" && entry.grantedPermissions.tools.length > 0) {
      throw new Error(`Data-only plugin cannot register executable tools: ${entry.id}@${entry.version}`);
    }
    this.#validateToolRegistrations([entry]);
    const created: string[] = [];
    try {
      for (const tool of entry.grantedPermissions.tools) {
        if (this.#registeredTools.has(tool)) continue;
        const handler = async (params: ToolExecutionContext) => {
          const version = this.#resolveVersion(entry.id, params);
          if (!version) throw new Error(`Plugin is disabled: ${entry.id}`);
          const selected = this.#requiredEntry(entry.id, version);
          if (!selected.grantedPermissions.tools.includes(tool)) {
            throw new Error(`Plugin tool is not present in the pinned generation: ${tool}`);
          }
          const generation = this.#generation(selected);
          if (!generation.supervisor) throw new Error(`Plugin tool cannot execute from a data-only package: ${tool}`);
          const value = await generation.supervisor.invoke(tool, params.call.arguments);
          return {
            callId: params.call.id,
            ok: true,
            content: JSON.stringify(value),
            metadata: { pluginId: selected.id, pluginVersion: selected.version, pluginDigest: selected.digest },
          };
        };
        const dispose = this.options.runtime.registerDynamic(tool, handler, (context) => {
          const version = this.#resolveVersion(entry.id, context);
          if (!version) return undefined;
          const selected = this.#lock.read().plugins[pluginKey(entry.id, version)];
          if (!selected?.grantedPermissions.tools.includes(tool)) return undefined;
          return pluginToolDefinition(tool, selected);
        });
        this.#registeredTools.set(tool, { pluginId: entry.id, dispose });
        created.push(tool);
      }
      return created;
    } catch (error) {
      this.#disposeToolRegistrations(created);
      throw error;
    }
  }

  #disposeToolRegistrations(tools: readonly string[]): void {
    for (const tool of tools) {
      const registration = this.#registeredTools.get(tool);
      if (!registration) continue;
      registration.dispose();
      this.#registeredTools.delete(tool);
    }
  }

  #validateToolRegistrations(entries: readonly PluginLockEntry[]): void {
    const proposed = new Map<string, string>();
    for (const entry of entries) {
      for (const tool of entry.grantedPermissions.tools) {
        if (!/^[a-z][a-z0-9_]{0,127}$/.test(tool)) throw new Error(`Plugin tool name is invalid: ${tool}`);
        if (this.#reservedTools.has(tool)) throw new Error(`Plugin tool collides with a reserved Manager capability: ${tool}`);
        const proposedOwner = proposed.get(tool);
        if (proposedOwner && proposedOwner !== entry.id) throw new Error(`Plugin tool collision: ${tool}`);
        proposed.set(tool, entry.id);
        const registered = this.#registeredTools.get(tool);
        if (registered && registered.pluginId !== entry.id) throw new Error(`Plugin tool collision: ${tool}`);
        if (!registered && !this.options.runtime.canRegister(tool)) throw new Error(`Plugin tool collides with an existing runtime capability: ${tool}`);
      }
    }
  }

  #generation(entry: PluginLockEntry): PluginGeneration {
    const key = pluginKey(entry.id, entry.version);
    const existing = this.#generations.get(key);
    if (existing) return existing;
    const generation: PluginGeneration = { id: entry.id, version: entry.version };
    if (entry.trust !== "data-only") {
      generation.supervisor = new LazyPluginSupervisor(() => {
        const current = this.#requiredEntry(entry.id, entry.version);
        const inspected = inspectLockedPlugin(current);
        return createOpenClawCompatibilityWorker(
          inspected,
          current.grantedPermissions,
          { state: this.#readState(current) },
          { sandbox: this.#sandbox, timeoutMs: this.options.rpcTimeoutMs ?? 30_000 },
        );
      }, {
        idleTtlMs: this.options.idleTtlMs ?? 60_000,
        invocationTimeoutMs: this.options.invocationTimeoutMs ?? 30_000,
        cleanupRetryMs: this.options.cleanupRetryMs,
        crashBackoffBaseMs: this.options.crashBackoffBaseMs,
        crashBackoffMaxMs: this.options.crashBackoffMaxMs,
        onCleanupError: () => process.stderr.write(
          `lite-harness manager: plugin cleanup pending retry for ${entry.id}@${entry.version}\n`,
        ),
      });
    }
    this.#generations.set(key, generation);
    return generation;
  }

  async #verify(entry: PluginLockEntry, state: unknown): Promise<void> {
    const inspected = inspectLockedPlugin(entry);
    if (entry.trust === "data-only") return;
    const worker = createOpenClawCompatibilityWorker(
      inspected,
      entry.grantedPermissions,
      { state },
      { sandbox: this.#sandbox, timeoutMs: this.options.rpcTimeoutMs ?? 30_000 },
    );
    try { await worker.start(); }
    finally { await worker.stop(); }
  }

  async #migrate(
    candidate: PluginLockEntry,
    previous: PluginLockEntry,
    previousState: unknown,
  ): Promise<{ state: unknown; rollbackPossible: boolean }> {
    if (candidate.trust === "data-only") return { state: previousState, rollbackPossible: true };
    const inspected = inspectLockedPlugin(candidate);
    const worker: ExecutablePluginWorker = createOpenClawCompatibilityWorker(
      inspected,
      candidate.grantedPermissions,
      { state: previousState },
      { sandbox: this.#sandbox, timeoutMs: this.options.rpcTimeoutMs ?? 30_000 },
    );
    let result: unknown;
    try {
      await worker.start();
      result = await worker.migrate(previous.version, candidate.version);
    } finally { await worker.stop(); }
    if (result && typeof result === "object" && (result as { migrated?: unknown }).migrated === false) {
      throw new Error(`Plugin migration is not supported: ${candidate.id}@${candidate.version}`);
    }
    const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
    return {
      state: record && "state" in record ? record.state : result,
      rollbackPossible: record?.rollbackPossible !== false,
    };
  }

  #writeState(id: string, version: string, value: unknown): string {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(value); } catch { throw new Error("Plugin migration state must be JSON serializable"); }
    if (serialized === undefined) throw new Error("Plugin migration state must be JSON serializable");
    const data = Buffer.from(serialized, "utf8");
    if (data.length > 1024 * 1024) throw new Error("Plugin migration state exceeds 1 MiB");
    const digest = createHash("sha256").update(data).digest("hex");
    const directory = join(this.#stateRoot, id, version);
    const target = join(directory, `${digest}.json`);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(target)) {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, data, { mode: 0o600 });
      renameSync(temporary, target);
    }
    return digest;
  }

  #readState(entry: PluginLockEntry): unknown {
    if (!entry.stateDigest) return {};
    const path = resolve(this.#stateRoot, entry.id, entry.version, `${entry.stateDigest}.json`);
    const data = readFileSync(path);
    if (data.length > 1024 * 1024) throw new Error(`Plugin state snapshot exceeds 1 MiB: ${entry.id}@${entry.version}`);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== entry.stateDigest) throw new Error(`Plugin state snapshot digest mismatch: ${entry.id}@${entry.version}`);
    return JSON.parse(data.toString("utf8")) as unknown;
  }

  #requiredEntry(id: string, version: string): PluginLockEntry {
    const entry = this.#lock.read().plugins[pluginKey(id, version)];
    if (!entry) throw new Error(`Plugin is not installed: ${id}@${version}`);
    return entry;
  }

  #applyActivation(id: string, activeVersion?: string, previousVersion?: string, resumeVersion?: string): void {
    if (activeVersion) this.#active.set(id, activeVersion); else this.#active.delete(id);
    if (previousVersion) this.#previous.set(id, previousVersion); else this.#previous.delete(id);
    if (resumeVersion) this.#resume.set(id, resumeVersion); else this.#resume.delete(id);
  }

  async #stopGeneration(id: string, version: string): Promise<void> {
    await this.#generations.get(pluginKey(id, version))?.supervisor?.stop();
  }

  async #stopGenerationWithBudget(id: string, version: string): Promise<unknown | undefined> {
    const attempts = Math.max(1, this.options.cleanupMaxAttempts ?? 3);
    let failure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#stopGeneration(id, version);
        this.#lock.clearCleanupDebt(id, version);
        return undefined;
      } catch (error) {
        failure = error;
        if (attempt < attempts) {
          await new Promise<void>((resolveRetry) => setTimeout(
            resolveRetry,
            Math.max(1, this.options.cleanupRetryMs ?? 100),
          ));
        }
      }
    }
    return failure ?? new Error("Plugin cleanup failed");
  }

  #recordCleanupDebt(id: string, version: string, error: unknown): void {
    this.#lock.recordCleanupDebt(
      id,
      version,
      Math.max(1, this.options.cleanupMaxAttempts ?? 3),
      cleanupErrorMessage(error),
    );
    this.#scheduleCleanupDebtRetry(id, version);
  }

  #scheduleCleanupDebtRetry(id: string, version: string): void {
    const key = pluginKey(id, version);
    if (this.#stopped || this.#cleanupRetryTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.#cleanupRetryTimers.delete(key);
      void this.#exclusive(async () => {
        if (!this.#lock.read().cleanupDebts?.[key]) return;
        const failure = await this.#stopGenerationWithBudget(id, version);
        if (failure) {
          this.#lock.recordCleanupDebt(
            id,
            version,
            Math.max(1, this.options.cleanupMaxAttempts ?? 3),
            cleanupErrorMessage(failure),
          );
        }
      }).catch(() => undefined).finally(() => {
        if (!this.#stopped && this.#lock.read().cleanupDebts?.[key]) this.#scheduleCleanupDebtRetry(id, version);
      });
    }, Math.max(1_000, this.options.cleanupRetryMs ?? 1_000));
    timer.unref?.();
    this.#cleanupRetryTimers.set(key, timer);
  }

  #scheduleRunReleaseRetry(runId: string): void {
    if (this.#stopped || !this.#runPins.has(runId) || this.#releaseRetryTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.#releaseRetryTimers.delete(runId);
      void this.releaseRun(runId).catch(() => undefined);
    }, Math.max(1_000, this.options.cleanupRetryMs ?? 1_000));
    timer.unref?.();
    this.#releaseRetryTimers.set(runId, timer);
  }

  async #stopUnpinnedPluginGenerations(id: string): Promise<Array<{ id: string; version: string; error: unknown }>> {
    const generations = [...this.#generations.values()].filter((generation) =>
      generation.id === id && generation.supervisor &&
      ![...this.#runPins.values()].some((pins) => pins.get(id) === generation.version));
    const results = await Promise.all(generations.map(async (generation) => ({
      generation,
      error: await this.#stopGenerationWithBudget(generation.id, generation.version),
    })));
    return results.flatMap(({ generation, error }) => error
      ? [{ id: generation.id, version: generation.version, error }]
      : []);
  }

  #pruneToolRegistrations(pluginId: string): void {
    const remainingTools = new Set(
      Object.values(this.#lock.read().plugins)
        .filter((entry) => entry.id === pluginId)
        .flatMap((entry) => [...entry.grantedPermissions.tools]),
    );
    for (const [tool, registration] of this.#registeredTools) {
      if (registration.pluginId !== pluginId || remainingTools.has(tool)) continue;
      registration.dispose();
      this.#registeredTools.delete(tool);
    }
  }

  #activeSnapshots(): Array<{ id: string; version: string; digest: string }> {
    const lock = this.#lock.read();
    return [...this.#active].map(([id, version]) => {
      const entry = lock.plugins[pluginKey(id, version)];
      if (!entry) throw new Error(`Active plugin generation disappeared: ${id}@${version}`);
      return { id, version, digest: entry.digest };
    }).sort((left, right) => pluginKey(left.id, left.version).localeCompare(pluginKey(right.id, right.version)));
  }

  #assertRunning(): void {
    if (this.#stopped) throw new Error("Plugin lifecycle is stopped");
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolveOperation) => { release = resolveOperation; });
    await previous;
    try {
      this.#assertRunning();
      return await operation();
    } finally { release(); }
  }
}

function pluginKey(id: string, version: string): string { return `${id}@${version}`; }

function cleanupErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map((item) => cleanupErrorMessage(item)).join("; ").slice(0, 512);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function pluginToolDefinition(name: string, entry: PluginLockEntry): ToolDefinition {
  return {
    name,
    description: `Invoke ${name} from plugin ${entry.id}@${entry.version}.`,
    inputSchema: { type: "object", additionalProperties: true },
  };
}
