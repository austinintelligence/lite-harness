import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { JsonLineRpcClient, type ProcessSpec } from "@lite-harness/process-rpc";
import { killAndReapContainer, type DockerCommandOptions, type DockerCommandResult, type DockerCommandRunner } from "@lite-harness/runtime-docker";

export type PluginTrustClass = "data-only" | "official" | "isolated" | "openclaw-compat";

export interface PluginPermissions {
  tools: readonly string[];
  secrets: readonly string[];
  events: readonly string[];
  files: readonly string[];
  networkOrigins: readonly string[];
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  entry: string;
  trust: PluginTrustClass;
  permissions: PluginPermissions;
}

export interface InspectedPlugin {
  root: string;
  entryPath: string;
  manifest: PluginManifest;
}

export function inspectPluginManifest(manifestPath: string): InspectedPlugin {
  const root = realpathSync(dirname(manifestPath));
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const manifest = validateManifest(raw);
  if (isAbsolute(manifest.entry)) throw new Error("Plugin entry must be relative to the plugin root");
  const entryPath = realpathSync(resolve(root, manifest.entry));
  if (!isWithin(root, entryPath) || !statSync(entryPath).isFile()) {
    throw new Error("Plugin entry escapes the plugin root or is not a file");
  }
  return { root, entryPath, manifest };
}

export function grantPluginPermissions(
  declared: PluginPermissions,
  operatorGrant: Partial<PluginPermissions>,
): PluginPermissions {
  return {
    tools: intersect(declared.tools, operatorGrant.tools),
    secrets: intersect(declared.secrets, operatorGrant.secrets),
    events: intersect(declared.events, operatorGrant.events),
    files: intersect(declared.files, operatorGrant.files),
    networkOrigins: intersect(declared.networkOrigins, operatorGrant.networkOrigins),
  };
}

export interface PluginWorker {
  start(): Promise<void>;
  invoke(action: string, input: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

export interface ExecutablePluginWorker extends PluginWorker {
  migrate(from: string, to: string): Promise<unknown>;
}

export interface PluginProcessSpec extends ProcessSpec {
  cleanup?: () => Promise<void>;
}

export interface PluginExecutionSandbox {
  processSpec(plugin: InspectedPlugin, grants: PluginPermissions): PluginProcessSpec;
}

export class DockerPluginExecutionSandbox implements PluginExecutionSandbox {
  readonly #installationLabel: string;
  readonly #runner: DockerCommandRunner;

  constructor(private readonly config: {
    image: string;
    installationId: string;
    dockerCommand?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
    cleanupTimeoutMs?: number;
    cleanupRunner?: DockerCommandRunner;
  }) {
    if (!/^(?:sha256:[a-f0-9]{64}|[^@\s]+@sha256:[a-f0-9]{64})$/.test(config.image)) {
      throw new Error("Plugin sandbox image must be pinned by sha256 digest");
    }
    if (config.pidsLimit !== undefined && (!Number.isSafeInteger(config.pidsLimit) || config.pidsLimit < 16)) {
      throw new Error("Plugin sandbox PID limit must be an integer of at least 16");
    }
    if (config.cleanupTimeoutMs !== undefined && (!Number.isSafeInteger(config.cleanupTimeoutMs) || config.cleanupTimeoutMs < 1_000 || config.cleanupTimeoutMs > 120_000)) {
      throw new Error("Plugin cleanup timeout must be between 1000 and 120000 milliseconds");
    }
    if (!config.installationId.trim()) throw new Error("Plugin sandbox installation identity is required");
    this.#installationLabel = pluginLabelDigest(config.installationId);
    const dockerCommand = config.dockerCommand ?? "docker";
    this.#runner = config.cleanupRunner ?? ((args, options) => runDockerPluginCommand(dockerCommand, args, options));
  }

  processSpec(plugin: InspectedPlugin, _grants: PluginPermissions): PluginProcessSpec {
    const host = realpathSync(resolve(import.meta.dirname, "openclaw-host.mjs"));
    const entry = relative(plugin.root, plugin.entryPath).replaceAll("\\", "/");
    if (!entry || entry.startsWith("../") || entry.includes("\0")) throw new Error("Plugin entry escapes the sandbox package root");
    const containerName = managedPluginContainerName(this.config.installationId, plugin.manifest.id, plugin.manifest.version);
    return {
      command: this.config.dockerCommand ?? "docker",
      args: [
        "run", "--pull=never", "--interactive", "--init", "--name", containerName,
        "--label", "lite-harness.managed=true", "--label", "lite-harness.component=plugin",
        "--label", `lite-harness.installation=${this.#installationLabel}`,
        "--label", `lite-harness.plugin=${pluginLabelDigest(`${plugin.manifest.id}@${plugin.manifest.version}`)}`,
        "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges=true", "--user", "1000:1000",
        "--pids-limit", String(this.config.pidsLimit ?? 64),
        "--memory", this.config.memory ?? "256m",
        "--cpus", this.config.cpus ?? "1",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777",
        "--mount", dockerReadOnlyBind(plugin.root, "/plugin"),
        "--mount", dockerReadOnlyBind(host, "/lite/openclaw-host.mjs"),
        "--workdir", "/plugin",
        "--env", `LITE_PLUGIN_ENTRY=/plugin/${entry}`,
        this.config.image,
        "node", "/lite/openclaw-host.mjs",
      ],
      inheritEnv: ["PATH", "Path", "SystemRoot", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"],
      cleanup: () => this.#cleanupContainer(containerName),
    };
  }

  async reconcileContainers(): Promise<number> {
    const listed = await this.#runner([
      "ps", "--all", "--no-trunc",
      "--filter", "label=lite-harness.managed=true",
      "--filter", "label=lite-harness.component=plugin",
      "--filter", `label=lite-harness.installation=${this.#installationLabel}`,
      "--format", "{{.ID}}",
    ]);
    if (listed.code !== 0) throw new Error(`Could not list managed plugin containers: ${listed.stderr}`);
    const containerIds = [...new Set(listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
    const failures: unknown[] = [];
    for (const containerId of containerIds) {
      try { await this.#cleanupContainer(containerId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Plugin startup reconciliation failed");
    return containerIds.length;
  }

  async #cleanupContainer(containerId: string): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = this.config.cleanupTimeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(new Error(`Plugin Docker cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    const runner: DockerCommandRunner = (args, options = {}) => this.#runner(args, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    });
    try { await killAndReapContainer(runner, containerId); }
    finally { clearTimeout(timer); }
  }
}

export interface PluginLockEntry {
  id: string;
  version: string;
  source: string;
  digest: string;
  installedAt: string;
  trust: PluginTrustClass;
  grantedPermissions: PluginPermissions;
  enabled: boolean;
}

export interface PluginLockfile {
  schemaVersion: 1;
  plugins: Record<string, PluginLockEntry>;
}

export class PluginInstallLock {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  read(): PluginLockfile {
    try {
      const value = JSON.parse(readFileSync(this.#path, "utf8")) as PluginLockfile;
      if (value.schemaVersion !== 1 || !value.plugins || typeof value.plugins !== "object") throw new Error("Plugin lockfile is invalid");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, plugins: {} };
      throw error;
    }
  }

  install(inspected: InspectedPlugin, grant: Partial<PluginPermissions>): PluginLockEntry {
    const lock = this.read();
    const key = `${inspected.manifest.id}@${inspected.manifest.version}`;
    const entry: PluginLockEntry = {
      id: inspected.manifest.id,
      version: inspected.manifest.version,
      source: inspected.root,
      digest: pluginPackageDigest(inspected),
      installedAt: new Date().toISOString(),
      trust: inspected.manifest.trust,
      grantedPermissions: grantPluginPermissions(inspected.manifest.permissions, grant),
      enabled: false,
    };
    lock.plugins[key] = entry;
    this.#write(lock);
    return entry;
  }

  setEnabled(id: string, version: string, enabled: boolean): PluginLockEntry {
    validatePackageCoordinates(id, version);
    const lock = this.read();
    const key = `${id}@${version}`;
    const existing = lock.plugins[key];
    if (!existing) throw new Error(`Plugin is not installed: ${key}`);
    lock.plugins[key] = { ...existing, enabled };
    this.#write(lock);
    return lock.plugins[key] as PluginLockEntry;
  }

  uninstall(id: string, version: string): boolean {
    validatePackageCoordinates(id, version);
    const lock = this.read();
    const key = `${id}@${version}`;
    if (!lock.plugins[key]) return false;
    delete lock.plugins[key];
    this.#write(lock);
    return true;
  }

  #write(lock: PluginLockfile): void {
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

export class PluginPackageInstaller {
  constructor(
    private readonly root: string,
    private readonly lock: PluginInstallLock,
    private readonly limits: { maxFiles?: number; maxBytes?: number } = {},
  ) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  stage(sourceRoot: string, manifestName = "lite-plugin.json"): InspectedPlugin {
    const source = realpathSync(sourceRoot);
    const sourceManifest = inspectPluginManifest(resolve(source, manifestName));
    const staging = resolve(this.root, `.stage-${process.pid}-${Date.now()}`);
    if (isWithin(source, staging)) throw new Error("Plugin source may not contain the install staging directory");
    try {
      copyPackageTree(source, staging, this.limits.maxFiles ?? 2_048, this.limits.maxBytes ?? 64 * 1024 * 1024);
      const staged = inspectPluginManifest(resolve(staging, manifestName));
      if (staged.manifest.id !== sourceManifest.manifest.id || staged.manifest.version !== sourceManifest.manifest.version) {
        throw new Error("Staged plugin identity changed during copy");
      }
      const target = resolve(this.root, staged.manifest.id, staged.manifest.version);
      if (!isWithin(this.root, target)) throw new Error("Plugin version escapes the install root");
      if (isWithin(target, staging) || isWithin(staging, target)) throw new Error("Plugin staging path is invalid");
      mkdirSync(dirname(target), { recursive: true });
      try { statSync(target); throw new Error(`Plugin package already exists: ${staged.manifest.id}@${staged.manifest.version}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      renameSync(staging, target);
      return inspectPluginManifest(resolve(target, manifestName));
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async installAndVerify(
    sourceRoot: string,
    grant: Partial<PluginPermissions>,
    verify: (plugin: InspectedPlugin, entry: PluginLockEntry) => Promise<void>,
    previousVersion?: string,
  ): Promise<PluginLockEntry> {
    const staged = this.stage(sourceRoot);
    const entry = this.lock.install(staged, grant);
    try {
      await verify(staged, entry);
      const enabled = this.lock.setEnabled(entry.id, entry.version, true);
      for (const installed of Object.values(this.lock.read().plugins)) {
        if (installed.id === entry.id && installed.version !== entry.version && installed.enabled) {
          this.lock.setEnabled(installed.id, installed.version, false);
        }
      }
      if (previousVersion && previousVersion !== entry.version) this.lock.setEnabled(entry.id, previousVersion, false);
      return enabled;
    } catch (error) {
      this.lock.uninstall(entry.id, entry.version);
      rmSync(staged.root, { recursive: true, force: true });
      throw error;
    }
  }

  uninstall(id: string, version: string): boolean {
    validatePackageCoordinates(id, version);
    const target = resolve(this.root, id, version);
    if (!isWithin(this.root, target)) throw new Error("Plugin uninstall path escapes the install root");
    const removed = this.lock.uninstall(id, version);
    if (removed) rmSync(target, { recursive: true, force: true });
    return removed;
  }
}

export class ProcessPluginWorker implements PluginWorker {
  readonly #rpc: JsonLineRpcClient;
  readonly #cleanup: (() => Promise<void>) | undefined;
  #started = false;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(
    spec: PluginProcessSpec,
    private readonly initialization: {
      manifest: PluginManifest;
      config: unknown;
      grants: PluginPermissions;
    },
    options: { timeoutMs?: number; maxPayloadBytes?: number } = {},
  ) {
    this.#cleanup = spec.cleanup;
    this.#rpc = new JsonLineRpcClient(spec, {
      requestTimeoutMs: options.timeoutMs ?? 30_000,
      maxLineBytes: options.maxPayloadBytes ?? 4 * 1024 * 1024,
      jsonRpcVersion: "2.0",
      onServerRequest: async (request) => {
        throw new Error(`Plugin host callback is not brokered: ${request.method}`);
      },
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#startPromise) return await this.#startPromise;
    const operation = this.#start();
    this.#startPromise = operation;
    try { await operation; }
    finally { if (this.#startPromise === operation) this.#startPromise = undefined; }
  }

  async #start(): Promise<void> {
    try {
      await this.#rpc.request("initialize", this.initialization);
      await this.#rpc.request("health", {});
      this.#started = true;
    } catch (error) {
      try { await this.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Plugin startup and cleanup both failed"); }
      throw error;
    }
  }

  async invoke(action: string, input: unknown): Promise<unknown> {
    await this.start();
    return await this.#rpc.request("invoke", { action, input });
  }

  async migrate(from: string, to: string): Promise<unknown> {
    await this.start();
    return await this.#rpc.request("migrate", { from, to });
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) return await this.#stopPromise;
    const operation = this.#stopAndReap();
    this.#stopPromise = operation;
    try { await operation; }
    finally { if (this.#stopPromise === operation) this.#stopPromise = undefined; }
  }

  async #stopAndReap(): Promise<void> {
    const failures: unknown[] = [];
    if (this.#rpc.running) {
      try { await this.#rpc.request("shutdown", { deadlineMs: 2_000 }, { timeoutMs: 2_000 }); }
      catch { /* process termination remains authoritative */ }
    }
    this.#started = false;
    try { await this.#rpc.stop(); } catch (error) { failures.push(error); }
    try { await this.#cleanup?.(); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "Plugin process and container cleanup failed");
  }
}

/**
 * Loads the deliberately narrow compatibility ABI in a disposable child
 * process. The child receives no Lite-Harness service token or provider secret.
 */
export function createOpenClawCompatibilityWorker(
  plugin: InspectedPlugin,
  grants: PluginPermissions,
  config: unknown = {},
  options: { timeoutMs?: number; maxPayloadBytes?: number; sandbox?: PluginExecutionSandbox } = {},
): ExecutablePluginWorker {
  if (plugin.manifest.trust !== "openclaw-compat" && plugin.manifest.trust !== "isolated" && plugin.manifest.trust !== "official") {
    throw new Error(`Plugin trust class cannot execute code: ${plugin.manifest.trust}`);
  }
  if (!options.sandbox) return new SandboxRequiredPluginWorker();
  return new ProcessPluginWorker(
    options.sandbox.processSpec(plugin, grants),
    { manifest: plugin.manifest, config, grants },
    { timeoutMs: options.timeoutMs, maxPayloadBytes: options.maxPayloadBytes },
  );
}

class SandboxRequiredPluginWorker implements ExecutablePluginWorker {
  readonly #error = new Error("Executable plugin denied: an enforceable execution sandbox is required");
  async start(): Promise<void> { throw this.#error; }
  async invoke(): Promise<unknown> { throw this.#error; }
  async migrate(): Promise<unknown> { throw this.#error; }
  async stop(): Promise<void> { /* no process was started */ }
}

export class LazyPluginSupervisor {
  #worker: PluginWorker | undefined;
  #cleanupWorker: PluginWorker | undefined;
  #startPromise: Promise<PluginWorker> | undefined;
  #stopPromise: Promise<void> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #acceptedInvocations = 0;
  readonly #drainResolvers = new Set<() => void>();
  #stopRequested = false;
  #starts = 0;
  #failures = 0;
  #retryAt = 0;
  readonly #failedWorkers = new WeakSet<PluginWorker>();

  constructor(
    private readonly factory: () => PluginWorker,
    private readonly options: {
      idleTtlMs?: number;
      invocationTimeoutMs?: number;
      cleanupRetryMs?: number;
      onCleanupError?: (error: unknown) => void;
    } = {},
  ) {}

  get active(): boolean {
    return this.#worker !== undefined || this.#cleanupWorker !== undefined || this.#startPromise !== undefined || this.#stopPromise !== undefined;
  }

  get cleanupPending(): boolean {
    return this.#cleanupWorker !== undefined;
  }

  get startCount(): number {
    return this.#starts;
  }

  async invoke(action: string, input: unknown): Promise<unknown> {
    if (this.#stopPromise) await this.#stopPromise;
    if (this.#cleanupWorker) throw new Error("Plugin worker cleanup is pending; invocation is denied");
    if (Date.now() < this.#retryAt) throw new Error("Plugin worker is in crash backoff");
    this.#acceptedInvocations += 1;
    this.#clearIdleTimer();
    let worker: PluginWorker | undefined;
    let succeeded = false;
    let failed = false;
    let failure: unknown;
    let result: unknown;
    try {
      worker = await this.#ensureWorker();
      result = await withTimeout(
        worker.invoke(action, input),
        this.options.invocationTimeoutMs ?? 30_000,
        `Plugin action timed out: ${action}`,
      );
      if (!this.#failedWorkers.has(worker)) {
        this.#failures = 0;
        this.#retryAt = 0;
      }
      succeeded = true;
    } catch (error) {
      if (worker) this.#failedWorkers.add(worker);
      this.#failures += 1;
      this.#retryAt = Date.now() + Math.min(2 ** (this.#failures - 1) * 250, 30_000);
      failed = true;
      failure = error;
    } finally {
      this.#releaseInvocation();
    }
    if (failed) {
      try { await this.stop(); }
      catch (cleanupError) {
        const cleanupWorker = this.#cleanupWorker;
        if (cleanupWorker) this.#armCleanupRetry(cleanupWorker, cleanupError);
        throw new AggregateError([failure, cleanupError], "Plugin invocation failed and cleanup remains pending");
      }
      throw failure;
    }
    if (succeeded && worker === this.#worker && this.#acceptedInvocations === 0) this.#armIdleTimer();
    return result;
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) return await this.#stopPromise;
    this.#stopRequested = true;
    const operation = this.#stopWorker();
    this.#stopPromise = operation;
    try { await operation; }
    finally {
      this.#stopRequested = false;
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    }
  }

  async #stopWorker(): Promise<void> {
    this.#clearIdleTimer();
    await this.#waitForInvocations();
    const worker = this.#worker ?? this.#cleanupWorker;
    this.#worker = undefined;
    if (!worker) return;
    this.#cleanupWorker = worker;
    await worker.stop();
    if (this.#cleanupWorker === worker) this.#cleanupWorker = undefined;
  }

  async #ensureWorker(): Promise<PluginWorker> {
    if (this.#worker) return this.#worker;
    if (this.#cleanupWorker) throw new Error("Plugin worker cleanup is pending; a replacement cannot start");
    if (this.#startPromise) return await this.#startPromise;
    const worker = this.factory();
    const operation = (async () => {
      try {
        await worker.start();
        this.#worker = worker;
        this.#starts += 1;
        return worker;
      } catch (error) {
        try { await worker.stop(); }
        catch (cleanupError) {
          this.#cleanupWorker = worker;
          throw new AggregateError([error, cleanupError], "Plugin startup failed and cleanup remains pending");
        }
        throw error;
      }
    })();
    this.#startPromise = operation;
    try { return await operation; }
    finally { if (this.#startPromise === operation) this.#startPromise = undefined; }
  }

  #armIdleTimer(): void {
    const ttl = this.options.idleTtlMs ?? 60_000;
    if (ttl <= 0 || !this.#worker || this.#acceptedInvocations > 0 || this.#stopRequested) return;
    const worker = this.#worker;
    const timer = setTimeout(() => {
      if (this.#idleTimer !== timer || this.#worker !== worker || this.#acceptedInvocations > 0 || this.#stopRequested) return;
      this.#idleTimer = undefined;
      void this.stop().catch((error) => this.#armCleanupRetry(worker, error));
    }, ttl);
    this.#idleTimer = timer;
    timer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #armCleanupRetry(worker: PluginWorker, error: unknown): void {
    if (this.#cleanupWorker !== worker || this.#stopRequested) return;
    try { this.options.onCleanupError?.(error); } catch { /* cleanup retries must not depend on observers */ }
    const delay = Math.max(1, this.options.cleanupRetryMs ?? Math.min(Math.max(this.options.idleTtlMs ?? 60_000, 250), 5_000));
    const timer = setTimeout(() => {
      if (this.#idleTimer !== timer || this.#cleanupWorker !== worker || this.#stopRequested) return;
      this.#idleTimer = undefined;
      void this.stop().catch((retryError) => this.#armCleanupRetry(worker, retryError));
    }, delay);
    this.#idleTimer = timer;
    timer.unref?.();
  }

  #releaseInvocation(): void {
    this.#acceptedInvocations = Math.max(0, this.#acceptedInvocations - 1);
    if (this.#acceptedInvocations !== 0) return;
    for (const resolveDrain of this.#drainResolvers) resolveDrain();
    this.#drainResolvers.clear();
  }

  async #waitForInvocations(): Promise<void> {
    if (this.#acceptedInvocations === 0) return;
    await new Promise<void>((resolveDrain) => this.#drainResolvers.add(resolveDrain));
  }
}

export function pluginPackageDigest(inspected: InspectedPlugin): string {
  const hash = createHash("sha256");
  let files = 0; let bytes = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name); const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error("Plugin packages may not contain symbolic links");
      if (metadata.isDirectory()) { visit(path); continue; }
      if (!metadata.isFile()) throw new Error("Plugin packages may contain only regular files and directories");
      files += 1; bytes += metadata.size;
      if (files > 2_048 || bytes > 64 * 1024 * 1024) throw new Error("Plugin package exceeds digest limits");
      hash.update(relative(inspected.root, path).replaceAll("\\", "/")).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  visit(inspected.root);
  return hash.digest("hex");
}

function copyPackageTree(source: string, destination: string, maxFiles: number, maxBytes: number): void {
  let files = 0; let bytes = 0;
  const visit = (from: string, to: string) => {
    const metadata = lstatSync(from);
    if (metadata.isSymbolicLink()) throw new Error("Plugin packages may not contain symbolic links");
    if (metadata.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from)) visit(resolve(from, entry), resolve(to, entry));
      return;
    }
    if (!metadata.isFile()) throw new Error("Plugin packages may contain only regular files and directories");
    files += 1; bytes += metadata.size;
    if (files > maxFiles || bytes > maxBytes) throw new Error("Plugin package exceeds install limits");
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  };
  visit(source, destination);
}

function validateManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object") throw new Error("Plugin manifest must be an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error("Unsupported plugin manifest version");
  for (const key of ["id", "version", "entry", "trust"] as const) {
    if (typeof record[key] !== "string" || !record[key]) throw new Error(`Plugin manifest ${key} is required`);
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(record.id as string)) throw new Error("Plugin id is invalid");
  if (!isSafePluginVersion(record.version as string)) throw new Error("Plugin version is invalid");
  if (!["data-only", "official", "isolated", "openclaw-compat"].includes(record.trust as string)) {
    throw new Error("Plugin trust class is invalid");
  }
  const permissions = record.permissions as Record<string, unknown> | undefined;
  if (!permissions) throw new Error("Plugin permissions are required");
  const normalized = Object.fromEntries(
    ["tools", "secrets", "events", "files", "networkOrigins"].map((key) => {
      const list = permissions[key];
      if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
        throw new Error(`Plugin permission ${key} must be a string array`);
      }
      return [key, [...new Set(list)]];
    }),
  ) as unknown as PluginPermissions;
  return {
    schemaVersion: 1,
    id: record.id as string,
    version: record.version as string,
    entry: record.entry as string,
    trust: record.trust as PluginTrustClass,
    permissions: normalized,
  };
}

function validatePackageCoordinates(id: string, version: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(id)) throw new Error("Plugin id is invalid");
  if (!isSafePluginVersion(version)) throw new Error("Plugin version is invalid");
}

function isSafePluginVersion(version: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version);
}

function managedPluginContainerName(installationId: string, pluginId: string, version: string): string {
  const hash = createHash("sha256");
  for (const value of [installationId, pluginId, version]) hash.update(String(value.length)).update(":").update(value).update(";");
  return `lite-harness-plugin-${hash.digest("hex").slice(0, 32)}`;
}

function pluginLabelDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function runDockerPluginCommand(
  command: string,
  args: readonly string[],
  options: DockerCommandOptions = {},
): Promise<DockerCommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBytes = Math.min(options.maxOutputBytes ?? 64 * 1024, 64 * 1024);
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => reject(options.signal?.reason ?? new Error("Plugin Docker cleanup was aborted")));
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("Plugin Docker cleanup output exceeded 64 KiB")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolveCommand({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    })));
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Plugin Docker cleanup timed out after 15000ms")));
    }, 15_000);
    timer.unref?.();
  });
}

function dockerReadOnlyBind(source: string, destination: string): string {
  if (/[\r\n,]/.test(source)) throw new Error("Plugin sandbox bind source contains unsupported characters");
  return `type=bind,src=${source},dst=${destination},readonly`;
}

function intersect(declared: readonly string[], granted: readonly string[] | undefined): string[] {
  if (!granted) return [];
  const allowed = new Set(declared);
  return [...new Set(granted)].filter((item) => allowed.has(item));
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
