import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JsonLineRpcClient, type ProcessSpec } from "@lite-harness/process-rpc";

export interface BrowserOwner {
  appId: string;
  tenantId: string;
  userId: string;
  runId: string;
}

export interface BrowserNetworkPolicy {
  allowedOrigins?: readonly string[];
  allowPrivateNetworks?: boolean;
}

export async function assertBrowserUrlAllowed(
  rawUrl: string,
  policy: BrowserNetworkPolicy,
  resolver: (hostname: string) => Promise<readonly string[]> = defaultResolver,
): Promise<URL> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Browser URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Browser URL must not contain credentials");
  if (policy.allowedOrigins && !policy.allowedOrigins.includes(url.origin)) throw new Error(`Browser origin is not allowed: ${url.origin}`);
  const addresses = isIP(url.hostname) ? [url.hostname] : await resolver(url.hostname);
  if (addresses.length === 0) throw new Error("Browser hostname did not resolve");
  if (!policy.allowPrivateNetworks && addresses.some(isPrivateAddress)) {
    throw new Error("Browser navigation to private or metadata networks is denied");
  }
  return url;
}

export class BrowserSessionBroker {
  readonly #sessions = new Map<string, { owner: BrowserOwner; expiresAt: number; tabs: Set<string> }>();

  create(owner: BrowserOwner, ttlMs = 60_000): string {
    const id = `browser_${randomUUID().replaceAll("-", "")}`;
    this.#sessions.set(id, { owner: { ...owner }, expiresAt: Date.now() + ttlMs, tabs: new Set() });
    return id;
  }

  assertOwner(sessionId: string, owner: BrowserOwner): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) throw new Error("Browser session is unavailable or expired");
    if (Object.keys(owner).some((key) => owner[key as keyof BrowserOwner] !== session.owner[key as keyof BrowserOwner])) {
      throw new Error("Browser session does not belong to this run");
    }
  }

  attachTab(sessionId: string, owner: BrowserOwner, tabId: string): void {
    this.assertOwner(sessionId, owner);
    this.#sessions.get(sessionId)?.tabs.add(tabId);
  }

  close(sessionId: string, owner: BrowserOwner): void {
    this.assertOwner(sessionId, owner);
    this.#sessions.delete(sessionId);
  }

  get activeCount(): number {
    return this.#sessions.size;
  }
}

export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "snapshot" }
  | { action: "click"; ref: string; expectDownload?: boolean }
  | { action: "type"; ref: string; text: string }
  | { action: "select"; ref: string; value: string }
  | { action: "hover"; ref: string }
  | { action: "keyboard"; key: string }
  | { action: "wait"; milliseconds: number }
  | { action: "screenshot"; fullPage?: boolean }
  | { action: "pdf" }
  | { action: "upload"; ref: string; name: string; dataBase64: string }
  | { action: "back" | "forward" | "reload" };

export interface BrowserActionResult {
  url?: string;
  title?: string;
  snapshot?: { text: string; elements: Array<{ ref: string; role: string; name: string }> };
  artifact?: { name: string; mediaType: string; dataBase64: string; sizeBytes: number };
  value?: unknown;
}

export interface BrowserDriver {
  start(policy: BrowserNetworkPolicy): Promise<void>;
  execute(command: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult>;
  stop(): Promise<void>;
}

export interface BrowserAuditRecord {
  sessionId: string;
  owner: BrowserOwner;
  action: BrowserAction["action"];
  target?: string;
  allowed: boolean;
  createdAt: string;
  error?: string;
}

export class ProcessBrowserDriver implements BrowserDriver {
  readonly #rpc: JsonLineRpcClient;
  #started = false;

  constructor(spec: ProcessSpec, private readonly options: { timeoutMs?: number; maxPayloadBytes?: number } = {}) {
    this.#rpc = new JsonLineRpcClient(spec, {
      requestTimeoutMs: options.timeoutMs ?? 30_000,
      // A 16 MiB binary artifact expands to roughly 21.4 MiB as base64 plus
      // the JSON-RPC envelope. Keep this bounded while leaving enough room.
      maxLineBytes: options.maxPayloadBytes ?? 24 * 1024 * 1024,
      jsonRpcVersion: "2.0",
    });
  }

  async start(policy: BrowserNetworkPolicy): Promise<void> {
    if (this.#started) return;
    try {
      await this.#rpc.request("initialize", { policy });
      this.#started = true;
    } catch (error) {
      await this.#rpc.stop();
      throw error;
    }
  }

  async execute(command: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (!this.#started) throw new Error("Browser driver is not initialized");
    return await this.#rpc.request("invoke", command, { signal });
  }

  async stop(): Promise<void> {
    if (this.#started) {
      try { await this.#rpc.request("shutdown", {}, { timeoutMs: 2_000 }); } catch { /* authoritative process cleanup below */ }
    }
    this.#started = false;
    await this.#rpc.stop();
  }
}

export class DockerBrowserDriver extends ProcessBrowserDriver {
  constructor(options: {
    image: string;
    dockerCommand?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
    seccompProfile?: string;
    timeoutMs?: number;
  }) {
    if (!options.image.includes("@sha256:") && !/^sha256:[a-f0-9]{64}$/.test(options.image)) {
      throw new Error("Browser image must be pinned by sha256 digest");
    }
    super({
      command: options.dockerCommand ?? "docker",
      args: [
        "run", "--rm", "--interactive", "--init", "--user", "pwuser",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--security-opt", `seccomp=${options.seccompProfile ?? join(process.cwd(), "docker", "browser-runtime", "seccomp_profile.json")}`,
        "--ipc", "host",
        "--memory", options.memory ?? "1g", "--cpus", options.cpus ?? "1.5",
        "--pids-limit", String(options.pidsLimit ?? 256),
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        options.image,
      ],
    }, { timeoutMs: options.timeoutMs ?? 30_000 });
  }
}

interface ManagedSession {
  owner: BrowserOwner;
  policy: BrowserNetworkPolicy;
  driver: BrowserDriver;
  started: boolean;
  expiresAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class ManagedBrowserBroker {
  readonly #sessions = new Map<string, ManagedSession>();

  constructor(
    private readonly factory: () => BrowserDriver,
    private readonly options: {
      idleTtlMs?: number;
      maxSessions?: number;
      audit?: (record: BrowserAuditRecord) => void;
    } = {},
  ) {}

  create(owner: BrowserOwner, policy: BrowserNetworkPolicy = {}): string {
    if (this.#sessions.size >= (this.options.maxSessions ?? 8)) throw new Error("Browser session limit reached");
    const sessionId = `browser_${randomUUID().replaceAll("-", "")}`;
    const session: ManagedSession = {
      owner: { ...owner }, policy: { ...policy }, driver: this.factory(), started: false,
      expiresAt: Date.now() + (this.options.idleTtlMs ?? 60_000),
    };
    this.#sessions.set(sessionId, session);
    this.#armIdle(sessionId, session);
    return sessionId;
  }

  async execute(sessionId: string, owner: BrowserOwner, command: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    const session = this.#owned(sessionId, owner);
    const target = command.action === "navigate" ? command.url : "ref" in command ? command.ref : undefined;
    try {
      if (command.action === "navigate") await assertBrowserUrlAllowed(command.url, session.policy);
      if (!session.started) {
        await session.driver.start(session.policy);
        session.started = true;
      }
      const result = await session.driver.execute(command, signal);
      this.#audit(sessionId, session, command.action, true, target);
      this.#armIdle(sessionId, session);
      return result;
    } catch (error) {
      this.#audit(sessionId, session, command.action, false, target, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async close(sessionId: string, owner: BrowserOwner): Promise<void> {
    const session = this.#owned(sessionId, owner);
    this.#sessions.delete(sessionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    await session.driver.stop();
  }

  get activeCount(): number {
    return this.#sessions.size;
  }

  #owned(sessionId: string, owner: BrowserOwner): ManagedSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) throw new Error("Browser session is unavailable or expired");
    if (Object.keys(owner).some((key) => owner[key as keyof BrowserOwner] !== session.owner[key as keyof BrowserOwner])) {
      throw new Error("Browser session does not belong to this run");
    }
    return session;
  }

  #armIdle(sessionId: string, session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    const ttl = this.options.idleTtlMs ?? 60_000;
    session.expiresAt = Date.now() + ttl;
    session.idleTimer = setTimeout(() => {
      this.#sessions.delete(sessionId);
      void session.driver.stop();
    }, ttl);
    session.idleTimer.unref?.();
  }

  #audit(sessionId: string, session: ManagedSession, action: BrowserAction["action"], allowed: boolean, target?: string, error?: string): void {
    this.options.audit?.({
      sessionId, owner: { ...session.owner }, action, allowed, createdAt: new Date().toISOString(),
      ...(target ? { target } : {}), ...(error ? { error } : {}),
    });
  }
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (normalized === "::1" || normalized === "::" || /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = -1, b = -1] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224;
}
