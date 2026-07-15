import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
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
  | { action: "scroll"; deltaX?: number; deltaY?: number }
  | { action: "drag"; sourceRef: string; targetRef: string }
  | { action: "tabs" | "new_tab" }
  | { action: "switch_tab" | "close_tab"; tabId: string }
  | { action: "inspect" }
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
  restoreProfile?(data: string): Promise<void>;
  exportProfile?(): Promise<string>;
  stop(): Promise<void>;
}

export interface BrowserProfileStore {
  load(profileId: string, owner: Omit<BrowserOwner, "runId">): Promise<string | undefined>;
  save(profileId: string, owner: Omit<BrowserOwner, "runId">, data: string): Promise<void>;
}

export class EncryptedBrowserProfileStore implements BrowserProfileStore {
  constructor(private readonly root: string, private readonly masterKey: Buffer, private readonly maxBytes = 4 * 1024 * 1024) {
    if (masterKey.length !== 32) throw new Error("Browser profile key must be 32 bytes");
  }

  async load(profileId: string, owner: Omit<BrowserOwner, "runId">): Promise<string | undefined> {
    try {
      const encoded = readFileSync(this.#path(profileId, owner));
      const envelope = JSON.parse(encoded.toString("utf8")) as { version: number; nonce: string; tag: string; ciphertext: string };
      if (envelope.version !== 1) throw new Error("Browser profile version is unsupported");
      const decipher = createDecipheriv("aes-256-gcm", this.#key(profileId, owner), Buffer.from(envelope.nonce, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
      if (plaintext.length > this.maxBytes) throw new Error("Browser profile exceeds storage limit");
      return plaintext.toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(profileId: string, owner: Omit<BrowserOwner, "runId">, data: string): Promise<void> {
    const plaintext = Buffer.from(data);
    if (plaintext.length > this.maxBytes) throw new Error("Browser profile exceeds storage limit");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key(profileId, owner), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const path = this.#path(profileId, owner); const temporary = `${path}.${process.pid}.tmp`; const backup = `${path}.previous`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
    rmSync(backup, { force: true });
    try { renameSync(path, backup); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { renameSync(temporary, path); }
    catch (error) { try { renameSync(backup, path); } catch { /* preserve original error */ } throw error; }
    rmSync(backup, { force: true });
  }

  #path(profileId: string, owner: Omit<BrowserOwner, "runId">): string {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(profileId)) throw new Error("Browser profile id is invalid");
    const digest = createHash("sha256").update(browserProfileIdentity(profileId, owner)).digest("hex");
    return join(this.root, digest.slice(0, 2), `${digest}.json`);
  }

  #key(profileId: string, owner: Omit<BrowserOwner, "runId">): Buffer {
    return createHmac("sha256", this.masterKey).update(`${owner.appId}\0${owner.tenantId}\0${owner.userId}\0${profileId}`).digest();
  }
}

function browserProfileIdentity(profileId: string, owner: Omit<BrowserOwner, "runId">): string {
  return [owner.appId, owner.tenantId, owner.userId, profileId]
    .map((value) => `${Buffer.byteLength(value)}:${value}`)
    .join("|");
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

  constructor(
    spec: ProcessSpec,
    private readonly options: { timeoutMs?: number; maxPayloadBytes?: number; initialization?: Record<string, unknown> } = {},
  ) {
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
      await this.#rpc.request("initialize", { policy, ...(this.options.initialization ?? {}) });
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

  async restoreProfile(data: string): Promise<void> {
    if (!this.#started) throw new Error("Browser driver is not initialized");
    await this.#rpc.request("profile.restore", { data });
  }

  async exportProfile(): Promise<string> {
    if (!this.#started) throw new Error("Browser driver is not initialized");
    const result = await this.#rpc.request<{ data: string }>("profile.export", {});
    return result.data;
  }

  async stop(): Promise<void> {
    if (this.#started) {
      try { await this.#rpc.request("shutdown", {}, { timeoutMs: 2_000 }); } catch { /* authoritative process cleanup below */ }
    }
    this.#started = false;
    await this.#rpc.stop();
  }
}

export type BrowserDockerRunner = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type BrowserProcessFactory = (
  spec: ProcessSpec,
  options: { timeoutMs: number; initialization: Record<string, unknown> },
) => BrowserDriver;

/**
 * Owns the only network path out of the Chromium isolation network. Chromium
 * never joins the external bridge, so a renderer/container compromise cannot
 * bypass origin and private-address policy by ignoring browser hooks.
 */
export class ExternalBrowserEgressBroker {
  readonly networkName = `lite-browser-net-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  readonly containerName = `lite-browser-egress-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  #started = false;

  constructor(private readonly options: {
    image: string;
    dockerCommand?: string;
    runner?: BrowserDockerRunner;
    externalNetwork?: string;
  }) {}

  get proxyUrl(): string { return `http://${this.containerName}:8080`; }

  async start(policy: BrowserNetworkPolicy): Promise<void> {
    if (this.#started) return;
    const encodedPolicy = Buffer.from(JSON.stringify(policy)).toString("base64url");
    if (encodedPolicy.length > 64 * 1024) throw new Error("Browser egress policy is too large");
    const run = this.options.runner ?? ((args) => runDocker(this.options.dockerCommand ?? "docker", args));
    const network = await run(["network", "create", "--internal", "--driver", "bridge", this.networkName]);
    if (network.code !== 0) throw new Error(`Could not create browser isolation network: ${network.stderr}`);
    try {
      const proxy = await run([
        "run", "--detach", "--rm", "--name", this.containerName,
        "--network", this.networkName, "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "64",
        "--memory", "128m", "--cpus", "0.5", "--user", "pwuser",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
        "--env", `LITE_BROWSER_PROXY_POLICY=${encodedPolicy}`,
        "--entrypoint", "node", this.options.image, "/opt/lite-browser/proxy.mjs",
      ]);
      if (proxy.code !== 0) throw new Error(`Could not start external browser egress broker: ${proxy.stderr}`);
      const connected = await run(["network", "connect", this.options.externalNetwork ?? "bridge", this.containerName]);
      if (connected.code !== 0) throw new Error(`Could not connect browser egress broker externally: ${connected.stderr}`);
      const ready = await run([
        "exec", this.containerName, "node", "-e",
        "fetch('http://127.0.0.1:8080').then(r=>process.exit(r.status===403?0:1)).catch(()=>process.exit(1))",
      ]);
      if (ready.code !== 0) throw new Error(`External browser egress broker did not become ready: ${ready.stderr}`);
      this.#started = true;
    } catch (error) {
      await run(["container", "rm", "--force", this.containerName]).catch(() => undefined);
      await run(["network", "rm", this.networkName]).catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const run = this.options.runner ?? ((args) => runDocker(this.options.dockerCommand ?? "docker", args));
    await run(["container", "rm", "--force", this.containerName]).catch(() => undefined);
    await run(["network", "rm", this.networkName]).catch(() => undefined);
    this.#started = false;
  }
}

export class DockerBrowserDriver implements BrowserDriver {
  readonly #options: {
    image: string; dockerCommand?: string; memory?: string; cpus?: string; pidsLimit?: number;
    seccompProfile?: string; timeoutMs?: number; remoteCdpEndpoint?: string; dockerRunner?: BrowserDockerRunner;
    processFactory?: BrowserProcessFactory;
  };
  #driver?: BrowserDriver;
  #egress?: ExternalBrowserEgressBroker;

  constructor(options: {
    image: string;
    dockerCommand?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
    seccompProfile?: string;
    timeoutMs?: number;
    remoteCdpEndpoint?: string;
    dockerRunner?: BrowserDockerRunner;
    processFactory?: BrowserProcessFactory;
  }) {
    if (!options.image.includes("@sha256:") && !/^sha256:[a-f0-9]{64}$/.test(options.image)) {
      throw new Error("Browser image must be pinned by sha256 digest");
    }
    if (options.remoteCdpEndpoint) {
      validateRemoteCdpEndpoint(options.remoteCdpEndpoint);
      throw new Error("Remote CDP is disabled until it can use the external browser egress broker");
    }
    this.#options = { ...options };
  }

  async start(policy: BrowserNetworkPolicy): Promise<void> {
    if (this.#driver) return;
    const egress = new ExternalBrowserEgressBroker({
      image: this.#options.image,
      ...(this.#options.dockerCommand ? { dockerCommand: this.#options.dockerCommand } : {}),
      ...(this.#options.dockerRunner ? { runner: this.#options.dockerRunner } : {}),
    });
    await egress.start(policy);
    const spec: ProcessSpec = {
      command: this.#options.dockerCommand ?? "docker",
      args: [
        "run", "--rm", "--interactive", "--init", "--user", "pwuser",
        "--network", egress.networkName,
        "--env", `HTTP_PROXY=${egress.proxyUrl}`, "--env", `HTTPS_PROXY=${egress.proxyUrl}`,
        "--env", "NO_PROXY=localhost,127.0.0.1",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--security-opt", `seccomp=${this.#options.seccompProfile ?? join(process.cwd(), "docker", "browser-runtime", "seccomp_profile.json")}`,
        "--shm-size", "256m", "--memory", this.#options.memory ?? "1g", "--cpus", this.#options.cpus ?? "1.5",
        "--pids-limit", String(this.#options.pidsLimit ?? 256), "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        this.#options.image,
      ],
    };
    const processOptions = {
      timeoutMs: this.#options.timeoutMs ?? 30_000,
      initialization: { proxyServer: egress.proxyUrl },
    };
    const driver = this.#options.processFactory
      ? this.#options.processFactory(spec, processOptions)
      : new ProcessBrowserDriver(spec, processOptions);
    try {
      await driver.start(policy);
      this.#egress = egress;
      this.#driver = driver;
    } catch (error) {
      await driver.stop().catch(() => undefined);
      await egress.stop();
      throw error;
    }
  }

  execute(command: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (!this.#driver) throw new Error("Browser driver is not initialized");
    return this.#driver.execute(command, signal);
  }
  restoreProfile(data: string): Promise<void> {
    if (!this.#driver?.restoreProfile) throw new Error("Browser driver does not support profile restore");
    return this.#driver.restoreProfile(data);
  }
  exportProfile(): Promise<string> {
    if (!this.#driver?.exportProfile) throw new Error("Browser driver does not support profile export");
    return this.#driver.exportProfile();
  }
  async stop(): Promise<void> {
    const driver = this.#driver; const egress = this.#egress;
    this.#driver = undefined; this.#egress = undefined;
    try { await driver?.stop(); } finally { await egress?.stop(); }
  }
}

function validateRemoteCdpEndpoint(value: string): string {
  const url = new URL(value);
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Remote CDP endpoint is invalid");
  }
  return url.toString();
}

function runDocker(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        child.kill();
        reject(new Error("Docker command output exceeded 1 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8").trim(),
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
    }));
  });
}

interface ManagedSession {
  owner: BrowserOwner;
  policy: BrowserNetworkPolicy;
  driver: BrowserDriver;
  started: boolean;
  expiresAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  profileId?: string;
  profileLoaded: boolean;
}

export class ManagedBrowserBroker {
  readonly #sessions = new Map<string, ManagedSession>();

  constructor(
    private readonly factory: () => BrowserDriver,
    private readonly options: {
      idleTtlMs?: number;
      maxSessions?: number;
      audit?: (record: BrowserAuditRecord) => void;
      profileStore?: BrowserProfileStore;
    } = {},
  ) {}

  create(owner: BrowserOwner, policy: BrowserNetworkPolicy = {}, profileId?: string): string {
    if (this.#sessions.size >= (this.options.maxSessions ?? 8)) throw new Error("Browser session limit reached");
    const sessionId = `browser_${randomUUID().replaceAll("-", "")}`;
    const session: ManagedSession = {
      owner: { ...owner }, policy: { ...policy }, driver: this.factory(), started: false,
      expiresAt: Date.now() + (this.options.idleTtlMs ?? 60_000), profileLoaded: false,
      ...(profileId ? { profileId } : {}),
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
        if (session.profileId && this.options.profileStore && session.driver.restoreProfile) {
          const data = await this.options.profileStore.load(session.profileId, browserProfileOwner(session.owner));
          if (data) await session.driver.restoreProfile(data);
          session.profileLoaded = true;
        }
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
    await this.#stopSession(session);
  }

  get activeCount(): number {
    return this.#sessions.size;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(async (session) => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      await this.#stopSession(session);
    }));
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
      void this.#stopSession(session).catch(async () => {
        try { await session.driver.stop(); } catch { /* idle cleanup is best-effort */ }
      });
    }, ttl);
    session.idleTimer.unref?.();
  }

  #audit(sessionId: string, session: ManagedSession, action: BrowserAction["action"], allowed: boolean, target?: string, error?: string): void {
    this.options.audit?.({
      sessionId, owner: { ...session.owner }, action, allowed, createdAt: new Date().toISOString(),
      ...(target ? { target } : {}), ...(error ? { error } : {}),
    });
  }

  async #stopSession(session: ManagedSession): Promise<void> {
    if (session.started && session.profileId && session.profileLoaded && this.options.profileStore && session.driver.exportProfile) {
      const data = await session.driver.exportProfile();
      await this.options.profileStore.save(session.profileId, browserProfileOwner(session.owner), data);
    }
    await session.driver.stop();
  }
}

function browserProfileOwner(owner: BrowserOwner): Omit<BrowserOwner, "runId"> {
  return { appId: owner.appId, tenantId: owner.tenantId, userId: owner.userId };
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
