import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { JsonLineRpcClient, type ProcessSpec } from "@lite-harness/process-rpc";

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
    const lock = this.read();
    const key = `${id}@${version}`;
    const existing = lock.plugins[key];
    if (!existing) throw new Error(`Plugin is not installed: ${key}`);
    lock.plugins[key] = { ...existing, enabled };
    this.#write(lock);
    return lock.plugins[key] as PluginLockEntry;
  }

  uninstall(id: string, version: string): boolean {
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
  ) { mkdirSync(root, { recursive: true }); }

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
    const removed = this.lock.uninstall(id, version);
    if (removed) rmSync(resolve(this.root, id, version), { recursive: true, force: true });
    return removed;
  }
}

export class ProcessPluginWorker implements PluginWorker {
  readonly #rpc: JsonLineRpcClient;
  #started = false;

  constructor(
    spec: ProcessSpec,
    private readonly initialization: {
      manifest: PluginManifest;
      config: unknown;
      grants: PluginPermissions;
    },
    options: { timeoutMs?: number; maxPayloadBytes?: number } = {},
  ) {
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
    await this.#rpc.request("initialize", this.initialization);
    await this.#rpc.request("health", {});
    this.#started = true;
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
    if (!this.#started) return;
    try { await this.#rpc.request("shutdown", { deadlineMs: 2_000 }, { timeoutMs: 2_000 }); }
    catch { /* process termination remains authoritative */ }
    this.#started = false;
    await this.#rpc.stop();
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
  options: { timeoutMs?: number; maxPayloadBytes?: number } = {},
): ProcessPluginWorker {
  if (plugin.manifest.trust !== "openclaw-compat" && plugin.manifest.trust !== "isolated" && plugin.manifest.trust !== "official") {
    throw new Error(`Plugin trust class cannot execute code: ${plugin.manifest.trust}`);
  }
  return new ProcessPluginWorker({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "openclaw-host.mjs")],
    cwd: plugin.root,
    env: { LITE_PLUGIN_ENTRY: plugin.manifest.entry },
  }, { manifest: plugin.manifest, config, grants }, options);
}

export class LazyPluginSupervisor {
  #worker: PluginWorker | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #starts = 0;
  #failures = 0;
  #retryAt = 0;

  constructor(
    private readonly factory: () => PluginWorker,
    private readonly options: { idleTtlMs?: number; invocationTimeoutMs?: number } = {},
  ) {}

  get active(): boolean {
    return this.#worker !== undefined;
  }

  get startCount(): number {
    return this.#starts;
  }

  async invoke(action: string, input: unknown): Promise<unknown> {
    if (Date.now() < this.#retryAt) throw new Error("Plugin worker is in crash backoff");
    try {
      const worker = await this.#ensureWorker();
      this.#clearIdleTimer();
      const result = await withTimeout(
        worker.invoke(action, input),
        this.options.invocationTimeoutMs ?? 30_000,
        `Plugin action timed out: ${action}`,
      );
      this.#armIdleTimer();
      this.#failures = 0;
      this.#retryAt = 0;
      return result;
    } catch (error) {
      this.#failures += 1;
      this.#retryAt = Date.now() + Math.min(2 ** (this.#failures - 1) * 250, 30_000);
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#clearIdleTimer();
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) await worker.stop();
  }

  async #ensureWorker(): Promise<PluginWorker> {
    if (this.#worker) return this.#worker;
    const worker = this.factory();
    await worker.start();
    this.#worker = worker;
    this.#starts += 1;
    return worker;
  }

  #armIdleTimer(): void {
    const ttl = this.options.idleTtlMs ?? 60_000;
    if (ttl <= 0) return;
    this.#idleTimer = setTimeout(() => { void this.stop().catch(() => undefined); }, ttl);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
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
