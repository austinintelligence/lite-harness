import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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

export class LazyPluginSupervisor {
  #worker: PluginWorker | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #starts = 0;

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
    const worker = await this.#ensureWorker();
    this.#clearIdleTimer();
    try {
      const result = await withTimeout(
        worker.invoke(action, input),
        this.options.invocationTimeoutMs ?? 30_000,
        `Plugin action timed out: ${action}`,
      );
      this.#armIdleTimer();
      return result;
    } catch (error) {
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
    this.#idleTimer = setTimeout(() => void this.stop(), ttl);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }
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
