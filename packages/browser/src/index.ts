import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  | { action: "upload"; ref: string; artifactId?: string; name?: string; quarantineId?: string }
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
  artifact?: { name: string; mediaType: string; quarantineId: string; sizeBytes: number; localPath?: string };
  value?: unknown;
}

export interface BrowserDriver {
  start(policy: BrowserNetworkPolicy): Promise<void>;
  execute(command: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult>;
  restoreProfile?(data: string): Promise<void>;
  exportProfile?(): Promise<string>;
  prepareUpload?(name: string, materialize: (path: string) => Promise<void>): Promise<string>;
  releaseArtifact?(localPath: string): void;
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

export interface BrowserDurabilityStore {
  createSession(sessionId: string, owner: BrowserOwner, policy: BrowserNetworkPolicy, profileId: string | undefined, expiresAt: string): void;
  touchSession(sessionId: string, owner: BrowserOwner, expiresAt: string): void;
  closeSession(sessionId: string, owner: BrowserOwner, state: "CLOSED" | "EXPIRED" | "FAILED"): void;
  recordAction(record: BrowserAuditRecord): void;
  recordArtifact(sessionId: string, owner: BrowserOwner, artifactId: string, direction: "UPLOAD" | "DOWNLOAD"): void;
}

export interface DurableBrowserActionRecord extends BrowserAuditRecord {
  id: number;
}

export class DurableBrowserSessionStore implements BrowserDurabilityStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        profile_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED','EXPIRED','FAILED','INTERRUPTED')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES browser_sessions(id),
        action TEXT NOT NULL,
        target TEXT,
        allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_artifacts (
        session_id TEXT NOT NULL REFERENCES browser_sessions(id),
        artifact_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('UPLOAD','DOWNLOAD')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, artifact_id, direction)
      );
      CREATE INDEX IF NOT EXISTS browser_sessions_owner_idx
        ON browser_sessions (app_id, tenant_id, user_id, run_id, id);
      CREATE INDEX IF NOT EXISTS browser_actions_session_idx
        ON browser_actions (session_id, id);
    `);
  }

  createSession(sessionId: string, owner: BrowserOwner, policy: BrowserNetworkPolicy, profileId: string | undefined, expiresAt: string): void {
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO browser_sessions (
        id, app_id, tenant_id, user_id, run_id, policy_json, profile_id,
        state, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)
    `).run(sessionId, owner.appId, owner.tenantId, owner.userId, owner.runId,
      JSON.stringify(policy), profileId ?? null, expiresAt, now, now);
  }

  touchSession(sessionId: string, owner: BrowserOwner, expiresAt: string): void {
    const result = this.#database.prepare(`
      UPDATE browser_sessions SET expires_at = ?, updated_at = ?
      WHERE id = ? AND app_id = ? AND tenant_id = ? AND user_id = ? AND run_id = ? AND state = 'OPEN'
    `).run(expiresAt, new Date().toISOString(), sessionId, owner.appId, owner.tenantId, owner.userId, owner.runId);
    if (result.changes !== 1) throw new Error("Durable browser session is unavailable or not owned by this run");
  }

  closeSession(sessionId: string, owner: BrowserOwner, state: "CLOSED" | "EXPIRED" | "FAILED"): void {
    const result = this.#database.prepare(`
      UPDATE browser_sessions SET state = ?, updated_at = ?
      WHERE id = ? AND app_id = ? AND tenant_id = ? AND user_id = ? AND run_id = ? AND state = 'OPEN'
    `).run(state, new Date().toISOString(), sessionId, owner.appId, owner.tenantId, owner.userId, owner.runId);
    if (result.changes !== 1) throw new Error("Durable browser session is unavailable or not owned by this run");
  }

  recordAction(record: BrowserAuditRecord): void {
    this.#assertOwner(record.sessionId, record.owner);
    this.#database.prepare(`
      INSERT INTO browser_actions (session_id, action, target, allowed, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.sessionId, record.action, record.target ?? null, record.allowed ? 1 : 0, record.error?.slice(0, 2_048) ?? null, record.createdAt);
  }

  recordArtifact(sessionId: string, owner: BrowserOwner, artifactId: string, direction: "UPLOAD" | "DOWNLOAD"): void {
    this.#assertOwner(sessionId, owner);
    if (!/^art_[a-f0-9]{32}$/i.test(artifactId)) throw new Error("Browser artifact id is invalid");
    this.#database.prepare(`
      INSERT OR IGNORE INTO browser_artifacts (session_id, artifact_id, direction, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, artifactId, direction, new Date().toISOString());
  }

  reconcileInterrupted(): number {
    const result = this.#database.prepare(`
      UPDATE browser_sessions SET state = 'INTERRUPTED', updated_at = ? WHERE state = 'OPEN'
    `).run(new Date().toISOString());
    return Number(result.changes);
  }

  listActions(sessionId: string, owner: BrowserOwner): DurableBrowserActionRecord[] {
    this.#assertOwner(sessionId, owner, false);
    const rows = this.#database.prepare(`
      SELECT id, action, target, allowed, error, created_at
      FROM browser_actions WHERE session_id = ? ORDER BY id
    `).all(sessionId) as Array<{ id: number; action: BrowserAction["action"]; target: string | null; allowed: number; error: string | null; created_at: string }>;
    return rows.map((row) => ({
      id: row.id, sessionId, owner: { ...owner }, action: row.action, allowed: row.allowed === 1,
      createdAt: row.created_at, ...(row.target ? { target: row.target } : {}), ...(row.error ? { error: row.error } : {}),
    }));
  }

  listArtifacts(sessionId: string, owner: BrowserOwner): Array<{ artifactId: string; direction: "UPLOAD" | "DOWNLOAD"; createdAt: string }> {
    this.#assertOwner(sessionId, owner, false);
    const rows = this.#database.prepare(`
      SELECT artifact_id, direction, created_at FROM browser_artifacts
      WHERE session_id = ? ORDER BY created_at, artifact_id
    `).all(sessionId) as Array<{ artifact_id: string; direction: "UPLOAD" | "DOWNLOAD"; created_at: string }>;
    return rows.map((row) => ({ artifactId: row.artifact_id, direction: row.direction, createdAt: row.created_at }));
  }

  close(): void { this.#database.close(); }

  #assertOwner(sessionId: string, owner: BrowserOwner, requireOpen = true): void {
    const row = this.#database.prepare(`
      SELECT state FROM browser_sessions
      WHERE id = ? AND app_id = ? AND tenant_id = ? AND user_id = ? AND run_id = ?
    `).get(sessionId, owner.appId, owner.tenantId, owner.userId, owner.runId) as { state: string } | undefined;
    if (!row || (requireOpen && row.state !== "OPEN")) throw new Error("Durable browser session is unavailable or not owned by this run");
  }
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
    installationId?: string;
  }) {}

  get proxyUrl(): string { return `http://${this.containerName}:8080`; }

  async start(policy: BrowserNetworkPolicy): Promise<void> {
    if (this.#started) return;
    const encodedPolicy = Buffer.from(JSON.stringify(policy)).toString("base64url");
    if (encodedPolicy.length > 64 * 1024) throw new Error("Browser egress policy is too large");
    const run = this.options.runner ?? ((args) => runDocker(this.options.dockerCommand ?? "docker", args));
    const installation = browserLabelDigest(this.options.installationId ?? process.cwd());
    const network = await run([
      "network", "create", "--internal", "--driver", "bridge",
      "--label", "lite-harness.managed=true", "--label", "lite-harness.kind=browser",
      "--label", `lite-harness.installation=${installation}`, this.networkName,
    ]);
    if (network.code !== 0) throw new Error(`Could not create browser isolation network: ${network.stderr}`);
    try {
      const proxy = await run([
        "run", "--pull=never", "--detach", "--rm", "--name", this.containerName,
        "--label", "lite-harness.managed=true", "--label", "lite-harness.kind=browser",
        "--label", "lite-harness.browser-role=egress", "--label", `lite-harness.installation=${installation}`,
        "--network", this.networkName, "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "64",
        "--memory", "128m", "--cpus", "0.5", "--user", "pwuser",
        "--add-host", "host.docker.internal:host-gateway",
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
    processFactory?: BrowserProcessFactory; quarantineRoot?: string; installationId?: string;
    maxRetainedUploads?: number; maxRetainedUploadBytes?: number;
  };
  #driver?: BrowserDriver;
  #egress?: ExternalBrowserEgressBroker;
  #quarantineRoot?: string;
  #retainedUploads = new Map<string, number>();
  #retainedUploadBytes = 0;
  #pendingUploads = 0;

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
    quarantineRoot?: string;
    installationId?: string;
    maxRetainedUploads?: number;
    maxRetainedUploadBytes?: number;
  }) {
    if (!options.image.includes("@sha256:") && !/^sha256:[a-f0-9]{64}$/.test(options.image)) {
      throw new Error("Browser image must be pinned by sha256 digest");
    }
    if (options.remoteCdpEndpoint) {
      validateRemoteCdpEndpoint(options.remoteCdpEndpoint);
      throw new Error("Remote CDP is disabled until it can use the external browser egress broker");
    }
    const maxRetainedUploads = options.maxRetainedUploads ?? 16;
    const maxRetainedUploadBytes = options.maxRetainedUploadBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(maxRetainedUploads) || maxRetainedUploads < 1 || maxRetainedUploads > 1_000) {
      throw new Error("Browser retained upload count limit is invalid");
    }
    if (!Number.isSafeInteger(maxRetainedUploadBytes) || maxRetainedUploadBytes < 1 || maxRetainedUploadBytes > 1024 * 1024 * 1024) {
      throw new Error("Browser retained upload byte limit is invalid");
    }
    this.#options = { ...options, maxRetainedUploads, maxRetainedUploadBytes };
  }

  async start(policy: BrowserNetworkPolicy): Promise<void> {
    if (this.#driver) return;
    const quarantineBase = this.#options.quarantineRoot ?? tmpdir();
    mkdirSync(quarantineBase, { recursive: true, mode: 0o700 });
    const quarantineRoot = mkdtempSync(join(quarantineBase, "lite-browser-quarantine-"));
    chmodSync(quarantineRoot, 0o733);
    const egress = new ExternalBrowserEgressBroker({
      image: this.#options.image,
      ...(this.#options.dockerCommand ? { dockerCommand: this.#options.dockerCommand } : {}),
      ...(this.#options.dockerRunner ? { runner: this.#options.dockerRunner } : {}),
      installationId: this.#options.installationId ?? process.cwd(),
    });
    try { await egress.start(policy); }
    catch (error) { rmSync(quarantineRoot, { recursive: true, force: true }); throw error; }
    const spec: ProcessSpec = {
      command: this.#options.dockerCommand ?? "docker",
      args: [
        "run", "--pull=never", "--rm", "--interactive", "--init", "--user", "pwuser",
        "--label", "lite-harness.managed=true", "--label", "lite-harness.kind=browser",
        "--label", "lite-harness.browser-role=chromium",
        "--label", `lite-harness.installation=${browserLabelDigest(this.#options.installationId ?? process.cwd())}`,
        "--network", egress.networkName,
        "--env", `HTTP_PROXY=${egress.proxyUrl}`, "--env", `HTTPS_PROXY=${egress.proxyUrl}`,
        "--env", "NO_PROXY=localhost,127.0.0.1",
        "--mount", `type=bind,source=${quarantineRoot},target=/quarantine`,
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
      this.#quarantineRoot = quarantineRoot;
    } catch (error) {
      await driver.stop().catch(() => undefined);
      await egress.stop();
      rmSync(quarantineRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async execute(command: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (!this.#driver) throw new Error("Browser driver is not initialized");
    const result = await this.#driver.execute(command, signal);
    if (!result.artifact) return result;
    const localPath = this.#quarantinePath(result.artifact.quarantineId);
    const stat = lstatSync(localPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== result.artifact.sizeBytes || stat.size > 16 * 1024 * 1024) {
      throw new Error("Browser quarantine artifact failed validation");
    }
    return { ...result, artifact: { ...result.artifact, localPath } };
  }

  async prepareUpload(_name: string, materialize: (path: string) => Promise<void>): Promise<string> {
    if (!this.#driver || !this.#quarantineRoot) throw new Error("Browser driver is not initialized");
    if (this.#retainedUploads.size + this.#pendingUploads >= (this.#options.maxRetainedUploads ?? 16)) {
      throw new Error("Browser retained upload count quota exceeded");
    }
    this.#pendingUploads += 1;
    const quarantineId = `q_${randomBytes(16).toString("hex")}`;
    const path = this.#quarantinePath(quarantineId);
    try {
      await materialize(path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Browser upload artifact failed validation");
      if (this.#retainedUploadBytes + stat.size > (this.#options.maxRetainedUploadBytes ?? 128 * 1024 * 1024)) {
        throw new Error("Browser retained upload byte quota exceeded");
      }
      chmodSync(path, 0o644);
      this.#retainedUploads.set(path, stat.size);
      this.#retainedUploadBytes += stat.size;
      return quarantineId;
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    } finally {
      this.#pendingUploads = Math.max(0, this.#pendingUploads - 1);
    }
  }

  releaseArtifact(localPath: string): void {
    if (localPath !== this.#quarantinePath(basename(localPath))) throw new Error("Browser quarantine path is invalid");
    const retainedBytes = this.#retainedUploads.get(localPath);
    if (retainedBytes !== undefined) {
      this.#retainedUploads.delete(localPath);
      this.#retainedUploadBytes = Math.max(0, this.#retainedUploadBytes - retainedBytes);
    }
    rmSync(localPath, { force: true });
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
    const driver = this.#driver; const egress = this.#egress; const quarantineRoot = this.#quarantineRoot;
    this.#driver = undefined; this.#egress = undefined; this.#quarantineRoot = undefined;
    this.#retainedUploads.clear(); this.#retainedUploadBytes = 0; this.#pendingUploads = 0;
    try { await driver?.stop(); } finally {
      try { await egress?.stop(); } finally { if (quarantineRoot) rmSync(quarantineRoot, { recursive: true, force: true }); }
    }
  }

  #quarantinePath(quarantineId: string): string {
    if (!this.#quarantineRoot || !/^q_[a-f0-9]{32}$/.test(quarantineId)) throw new Error("Browser quarantine id is invalid");
    return join(this.#quarantineRoot, quarantineId);
  }
}

export async function reconcileBrowserResources(options: {
  installationId: string;
  dockerCommand?: string;
  runner?: BrowserDockerRunner;
}): Promise<{ containers: number; networks: number }> {
  if (!options.installationId.trim()) throw new Error("Browser reconciliation requires an installation identity");
  const run = options.runner ?? ((args) => runDocker(options.dockerCommand ?? "docker", args));
  const installation = browserLabelDigest(options.installationId);
  const filters = ["--filter", "label=lite-harness.managed=true", "--filter", "label=lite-harness.kind=browser",
    "--filter", `label=lite-harness.installation=${installation}`];
  const listedContainers = await run(["ps", "--all", "--no-trunc", ...filters, "--format", "{{.ID}}"]).catch((error) => ({
    code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error),
  }));
  if (listedContainers.code !== 0) throw new Error(`Could not list managed browser containers: ${listedContainers.stderr}`);
  const containerIds = listedContainers.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  for (const id of containerIds) {
    const removed = await run(["container", "rm", "--force", id]);
    if (removed.code !== 0) throw new Error(`Could not reap managed browser container: ${removed.stderr}`);
  }
  const listedNetworks = await run(["network", "ls", ...filters, "--format", "{{.ID}}"]).catch((error) => ({
    code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error),
  }));
  if (listedNetworks.code !== 0) throw new Error(`Could not list managed browser networks: ${listedNetworks.stderr}`);
  const networkIds = listedNetworks.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  for (const id of networkIds) {
    const removed = await run(["network", "rm", id]);
    if (removed.code !== 0) throw new Error(`Could not reap managed browser network: ${removed.stderr}`);
  }
  return { containers: containerIds.length, networks: networkIds.length };
}

function browserLabelDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
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
  activeOperations: number;
  closing: boolean;
  drainResolvers: Set<() => void>;
  startPromise?: Promise<void>;
  closePromise?: Promise<void>;
  profileId?: string;
  profileLoaded: boolean;
}

export class ManagedBrowserBroker {
  readonly #sessions = new Map<string, ManagedSession>();
  #closeAllPromise: Promise<void> | undefined;

  constructor(
    private readonly factory: () => BrowserDriver,
    private readonly options: {
      idleTtlMs?: number;
      maxSessions?: number;
      audit?: (record: BrowserAuditRecord) => void;
      profileStore?: BrowserProfileStore;
      durabilityStore?: BrowserDurabilityStore;
    } = {},
  ) {}

  create(owner: BrowserOwner, policy: BrowserNetworkPolicy = {}, profileId?: string): string {
    if (this.#closeAllPromise) throw new Error("Browser broker is closing all sessions");
    if (this.#sessions.size >= (this.options.maxSessions ?? 8)) throw new Error("Browser session limit reached");
    const sessionId = `browser_${randomUUID().replaceAll("-", "")}`;
    const session: ManagedSession = {
      owner: { ...owner }, policy: { ...policy }, driver: this.factory(), started: false,
      expiresAt: Date.now() + (this.options.idleTtlMs ?? 60_000), profileLoaded: false,
      activeOperations: 0, closing: false, drainResolvers: new Set(),
      ...(profileId ? { profileId } : {}),
    };
    this.options.durabilityStore?.createSession(
      sessionId, session.owner, session.policy, session.profileId, new Date(session.expiresAt).toISOString(),
    );
    this.#sessions.set(sessionId, session);
    this.#armIdle(sessionId, session);
    return sessionId;
  }

  async execute(sessionId: string, owner: BrowserOwner, command: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    const session = this.#beginOperation(sessionId, owner);
    const target = command.action === "navigate" ? command.url : "ref" in command ? command.ref : undefined;
    try {
      if (command.action === "navigate") await assertBrowserUrlAllowed(command.url, session.policy);
      await this.#ensureStarted(session);
      const result = await session.driver.execute(command, signal);
      this.#audit(sessionId, session, command.action, true, target);
      return result;
    } catch (error) {
      this.#audit(sessionId, session, command.action, false, target, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.#finishOperation(sessionId, session);
    }
  }

  async close(sessionId: string, owner: BrowserOwner): Promise<void> {
    const session = this.#owned(sessionId, owner);
    await this.#closeManagedSession(sessionId, session, "CLOSED");
  }

  async prepareUpload(
    sessionId: string,
    owner: BrowserOwner,
    name: string,
    materialize: (path: string) => Promise<void>,
  ): Promise<string> {
    const session = this.#beginOperation(sessionId, owner);
    try {
      await this.#ensureStarted(session);
      if (!session.driver.prepareUpload) throw new Error("Browser driver does not support authorized artifact uploads");
      return await session.driver.prepareUpload(name, materialize);
    } finally {
      this.#finishOperation(sessionId, session);
    }
  }

  recordArtifact(sessionId: string, owner: BrowserOwner, artifactId: string, direction: "UPLOAD" | "DOWNLOAD"): void {
    this.#owned(sessionId, owner);
    this.options.durabilityStore?.recordArtifact(sessionId, owner, artifactId, direction);
  }

  releaseArtifact(sessionId: string, owner: BrowserOwner, localPath: string): void {
    const session = this.#owned(sessionId, owner);
    if (!session.driver.releaseArtifact) throw new Error("Browser driver does not support quarantine release");
    session.driver.releaseArtifact(localPath);
  }

  get activeCount(): number {
    return this.#sessions.size;
  }

  async closeAll(): Promise<void> {
    if (this.#closeAllPromise) return await this.#closeAllPromise;
    const operation = this.#closeEverySession();
    this.#closeAllPromise = operation;
    try { await operation; }
    finally { if (this.#closeAllPromise === operation) this.#closeAllPromise = undefined; }
  }

  async #closeEverySession(): Promise<void> {
    const sessions = [...this.#sessions.entries()];
    const results = await Promise.allSettled(
      sessions.map(([sessionId, session]) => this.#closeManagedSession(sessionId, session, "CLOSED")),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "One or more browser sessions failed to close");
  }

  #owned(sessionId: string, owner: BrowserOwner): ManagedSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closing || (session.activeOperations === 0 && session.expiresAt <= Date.now())) {
      throw new Error("Browser session is unavailable, closing, or expired");
    }
    if (Object.keys(owner).some((key) => owner[key as keyof BrowserOwner] !== session.owner[key as keyof BrowserOwner])) {
      throw new Error("Browser session does not belong to this run");
    }
    return session;
  }

  #beginOperation(sessionId: string, owner: BrowserOwner): ManagedSession {
    const session = this.#owned(sessionId, owner);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    session.activeOperations += 1;
    return session;
  }

  #finishOperation(sessionId: string, session: ManagedSession): void {
    session.activeOperations = Math.max(0, session.activeOperations - 1);
    if (session.activeOperations === 0) {
      for (const resolveDrain of session.drainResolvers) resolveDrain();
      session.drainResolvers.clear();
    }
    if (session.activeOperations === 0 && this.#sessions.get(sessionId) === session) this.#armIdle(sessionId, session);
  }

  #beginClosing(sessionId: string, session: ManagedSession): void {
    session.closing = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  async #waitForOperations(session: ManagedSession): Promise<void> {
    if (session.activeOperations === 0) return;
    await new Promise<void>((resolveDrain) => session.drainResolvers.add(resolveDrain));
  }

  #closeManagedSession(sessionId: string, session: ManagedSession, state: "CLOSED" | "EXPIRED"): Promise<void> {
    if (session.closePromise) return session.closePromise;
    this.#beginClosing(sessionId, session);
    const operation = (async () => {
      try {
        await this.#waitForOperations(session);
        await this.#stopSession(session);
        this.options.durabilityStore?.closeSession(sessionId, session.owner, state);
      } catch (error) {
        try { this.options.durabilityStore?.closeSession(sessionId, session.owner, "FAILED"); } catch { /* preserve original failure */ }
        try { await session.driver.stop(); } catch { /* authoritative cleanup was already attempted */ }
        throw error;
      } finally {
        if (this.#sessions.get(sessionId) === session) this.#sessions.delete(sessionId);
      }
    })();
    session.closePromise = operation;
    return operation;
  }

  #armIdle(sessionId: string, session: ManagedSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.closing || session.activeOperations > 0 || this.#sessions.get(sessionId) !== session) return;
    const ttl = this.options.idleTtlMs ?? 60_000;
    session.expiresAt = Date.now() + ttl;
    this.options.durabilityStore?.touchSession(sessionId, session.owner, new Date(session.expiresAt).toISOString());
    const timer = setTimeout(() => {
      if (session.idleTimer !== timer || session.closing || session.activeOperations > 0 || this.#sessions.get(sessionId) !== session) return;
      session.idleTimer = undefined;
      void this.#closeManagedSession(sessionId, session, "EXPIRED").catch(() => undefined);
    }, ttl);
    session.idleTimer = timer;
    timer.unref?.();
  }

  #audit(sessionId: string, session: ManagedSession, action: BrowserAction["action"], allowed: boolean, target?: string, error?: string): void {
    const record: BrowserAuditRecord = {
      sessionId, owner: { ...session.owner }, action, allowed, createdAt: new Date().toISOString(),
      ...(target ? { target } : {}), ...(error ? { error } : {}),
    };
    this.options.durabilityStore?.recordAction(record);
    this.options.audit?.(record);
  }

  async #ensureStarted(session: ManagedSession): Promise<void> {
    if (session.started) return;
    if (session.startPromise) return await session.startPromise;
    const operation = (async () => {
      await session.driver.start(session.policy);
      if (session.profileId && this.options.profileStore && session.driver.restoreProfile) {
        const data = await this.options.profileStore.load(session.profileId, browserProfileOwner(session.owner));
        if (data) await session.driver.restoreProfile(data);
        session.profileLoaded = true;
      }
      session.started = true;
    })();
    session.startPromise = operation;
    try { await operation; }
    finally { if (session.startPromise === operation) session.startPromise = undefined; }
  }

  async #stopSession(session: ManagedSession): Promise<void> {
    if (session.startPromise) await session.startPromise.catch(() => undefined);
    if (session.started && session.profileId && session.profileLoaded && this.options.profileStore && session.driver.exportProfile) {
      const data = await session.driver.exportProfile();
      await this.options.profileStore.save(session.profileId, browserProfileOwner(session.owner), data);
    }
    session.started = false;
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
