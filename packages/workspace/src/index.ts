import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  webcrypto,
} from "node:crypto";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { createGunzip, createGzip } from "node:zlib";
import {
  createReadStream,
  createWriteStream,
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  statfsSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, posix, relative, win32 } from "node:path";
import { once } from "node:events";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactRecord, InternalPrincipal, WorkspaceRecord } from "@lite-harness/contracts";
import { createId } from "@lite-harness/domain";
import { validateWorkspacePath } from "@lite-harness/runtime";

const SNAPSHOT_MAGIC = "LHS2\n";
const SNAPSHOT_TAG_BYTES = 16;
const SNAPSHOT_HEADER_BYTES = 16 * 1024;
const ARTIFACT_MAGIC = "LHA1\n";
const ARTIFACT_TAG_BYTES = 16;

const POSIX_SENSITIVE_ROOTS = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root",
  "/run", "/sbin", "/sys", "/usr", "/var",
] as const;
const POSIX_SENSITIVE_EXACT_ROOTS = ["/home", "/Users"] as const;
const WINDOWS_SENSITIVE_SEGMENTS = [
  "windows", "program files", "program files (x86)", "programdata",
  "documents and settings",
] as const;
const HOME_SENSITIVE_CHILDREN = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config", ".docker",
  ".codex", ".openclaw", "appdata", "library",
] as const;

/** Canonicalizes a registered project directory and applies the portable host-bind deny policy. */
export function validateRegisteredBindRoot(input: string): string {
  if (!input.trim()) throw new Error("Registered workspace path is required");
  const canonical = realpathSync(input);
  if (!statSync(canonical).isDirectory()) throw new Error("Registered workspace path must be a directory");
  rejectSensitiveRegisteredRoot(canonical);
  return canonical;
}

/** Pure policy helper used to enforce the same rules at registration and consumption time. */
export function rejectSensitiveRegisteredRoot(input: string, homeDirectory = homedir(), temporaryDirectory = tmpdir()): void {
  const windows = isWindowsPath(input);
  const pathApi = windows ? win32 : posix;
  if (!pathApi.isAbsolute(input)) throw new Error("Registered workspace path must be absolute");
  const candidate = comparablePath(pathApi.normalize(input), windows);
  const filesystemRoot = comparablePath(pathApi.parse(input).root, windows);
  if (candidate === filesystemRoot) throw new Error("Registered workspace path cannot be a filesystem root");

  const comparableHome = homeDirectory && isWindowsPath(homeDirectory) === windows
    ? comparablePath(pathApi.normalize(homeDirectory), windows)
    : undefined;
  if (comparableHome && candidate === comparableHome) {
    throw new Error("Registered workspace path cannot be the whole user home");
  }
  if (comparableHome) {
    const comparableTemporary = temporaryDirectory && isWindowsPath(temporaryDirectory) === windows
      ? comparablePath(pathApi.normalize(temporaryDirectory), windows)
      : undefined;
    for (const child of HOME_SENSITIVE_CHILDREN) {
      if (isSameOrDescendant(candidate, comparablePath(pathApi.join(comparableHome, child), windows), pathApi.sep)) {
        if (comparableTemporary && isSameOrDescendant(candidate, comparableTemporary, pathApi.sep)) continue;
        throw new Error("Registered workspace path is inside a sensitive user directory");
      }
    }
  }

  if (windows) {
    const root = pathApi.parse(candidate).root;
    if (candidate === comparablePath(pathApi.join(root, "users"), true)) {
      throw new Error("Registered workspace path is a sensitive system directory");
    }
    for (const segment of WINDOWS_SENSITIVE_SEGMENTS) {
      if (isSameOrDescendant(candidate, comparablePath(pathApi.join(root, segment), true), pathApi.sep)) {
        throw new Error("Registered workspace path is inside a sensitive system directory");
      }
    }
    return;
  }
  if (POSIX_SENSITIVE_EXACT_ROOTS.includes(candidate as typeof POSIX_SENSITIVE_EXACT_ROOTS[number])) {
    throw new Error("Registered workspace path is a sensitive system directory");
  }
  for (const sensitive of POSIX_SENSITIVE_ROOTS) {
    if (isSameOrDescendant(candidate, sensitive, pathApi.sep)) {
      throw new Error("Registered workspace path is inside a sensitive system directory");
    }
  }
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}

function comparablePath(path: string, windows: boolean): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return windows ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendant(candidate: string, root: string, separator: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${separator}`);
}

export interface SnapshotKeyProvider {
  getKey(workspaceId: string): Promise<Buffer>;
  metadata?(): { keyVersion: 1; keyScope: "static" | "workspace-derived" };
}

export class StaticSnapshotKeyProvider implements SnapshotKeyProvider {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Snapshot key must be exactly 32 bytes");
  }

  async getKey(): Promise<Buffer> {
    return Buffer.from(this.key);
  }

  metadata(): { keyVersion: 1; keyScope: "static" } { return { keyVersion: 1, keyScope: "static" }; }
}

/** Derives an isolated snapshot data key without persisting the raw workspace key. */
export class DerivedSnapshotKeyProvider implements SnapshotKeyProvider {
  readonly #rootKey: Buffer;

  constructor(rootKey: Buffer) {
    if (rootKey.length !== 32) throw new Error("Snapshot root key must be exactly 32 bytes");
    this.#rootKey = Buffer.from(rootKey);
  }

  async getKey(workspaceId: string): Promise<Buffer> {
    if (!workspaceId.trim() || workspaceId.length > 512 || /[\0\r\n]/.test(workspaceId)) throw new Error("Snapshot workspace identity is invalid");
    return Buffer.from(hkdfSync("sha256", this.#rootKey, Buffer.from("lite-harness-snapshot-salt-v1"), Buffer.from(`workspace:${workspaceId}`), 32));
  }

  metadata(): { keyVersion: 1; keyScope: "workspace-derived" } { return { keyVersion: 1, keyScope: "workspace-derived" }; }
}

export interface SnapshotRecord {
  workspaceId: string;
  sha256: string;
  plaintextBytes: number;
  createdAt: string;
  path: string;
}

interface SnapshotHeader {
  schemaVersion: 2;
  workspaceId: string;
  createdAt: string;
  plaintextBytes: number;
  sha256: string;
  nonce: string;
  algorithm: "aes-256-gcm+gzip";
  keyVersion?: 1;
  keyScope?: "static" | "workspace-derived";
}

export class LocalWorkspaceSnapshotStore {
  constructor(
    private readonly root: string,
    private readonly keys: SnapshotKeyProvider,
    private readonly legacyKeys?: SnapshotKeyProvider,
    private readonly maxArchiveBytes = 512 * 1024 * 1024,
  ) {}

  async create(workspaceId: string, archive: Buffer): Promise<SnapshotRecord> {
    if (archive.length > this.maxArchiveBytes) throw new Error("Workspace snapshot exceeds the archive limit");
    const key = await this.keys.getKey(workspaceId);
    const nonce = randomBytes(12);
    const keyMetadata = this.keys.metadata?.();
    const header: SnapshotHeader = {
      schemaVersion: 2,
      workspaceId,
      createdAt: new Date().toISOString(),
      plaintextBytes: archive.length,
      sha256: Buffer.from(await webcrypto.subtle.digest("SHA-256", archive as unknown as BufferSource)).toString("hex"),
      nonce: nonce.toString("base64"),
      algorithm: "aes-256-gcm+gzip",
      ...(keyMetadata ?? {}),
    };
    const paths = this.#paths(workspaceId);
    await mkdir(dirname(paths.current), { recursive: true });
    try {
      await createStreamingSnapshotPipeline(archive, paths.staging, key, nonce, header);
      await this.#verifySnapshotBeforeRotation(workspaceId, paths.staging, header.sha256);
      await this.#rotateVerifiedSnapshots(workspaceId, paths);
      await rename(paths.staging, paths.current);
      await rm(paths.previousBackup, { force: true });
    } finally {
      await rm(paths.staging, { force: true });
    }
    return {
      workspaceId,
      sha256: header.sha256,
      plaintextBytes: archive.length,
      createdAt: header.createdAt,
      path: paths.current,
    };
  }

  async restore(workspaceId: string): Promise<{ archive: Buffer; recoveredFromPrevious: boolean }> {
    const paths = this.#paths(workspaceId);
    let currentError: unknown;
    try {
      return { archive: await this.#read(workspaceId, paths.current), recoveredFromPrevious: false };
    } catch (error) {
      currentError = error;
    }
    try {
      return { archive: await this.#read(workspaceId, paths.previous), recoveredFromPrevious: true };
    } catch (previousError) {
      try {
        return { archive: await this.#read(workspaceId, paths.previousBackup), recoveredFromPrevious: true };
      } catch (backupError) {
        throw new AggregateError([currentError, previousError, backupError], `No valid snapshot is available for ${workspaceId}`);
      }
    }
  }

  hasCandidates(workspaceId: string): boolean {
    const paths = this.#paths(workspaceId);
    return lstatExists(paths.current) || lstatExists(paths.previous) || lstatExists(paths.previousBackup);
  }

  async #read(workspaceId: string, path: string): Promise<Buffer> {
    const descriptor = await readSnapshotDescriptor(path, this.maxArchiveBytes);
    const header = descriptor.header;
    if (header.workspaceId !== workspaceId) throw new Error("Snapshot identity or version is invalid");
    const key = await this.#keyForHeader(workspaceId, header);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
    decipher.setAAD(snapshotAssociatedData(header));
    decipher.setAuthTag(descriptor.tag);
    const archive = await collectSnapshotArchive(
      createReadStream(path, { start: descriptor.ciphertextStart, end: descriptor.ciphertextEnd }),
      decipher,
      header.plaintextBytes,
      this.maxArchiveBytes,
    );
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== header.sha256 || archive.length !== header.plaintextBytes) {
      throw new Error("Snapshot content verification failed");
    }
    return archive;
  }

  async #keyForHeader(workspaceId: string, header: SnapshotHeader): Promise<Buffer> {
    // Snapshots written before key metadata was introduced used the static root
    // key. Production now derives a workspace-scoped key, so retain an explicit
    // legacy provider for a safe, authenticated upgrade path.
    if (header.keyScope === "workspace-derived") return this.keys.getKey(workspaceId);
    return this.legacyKeys?.getKey(workspaceId) ?? this.keys.getKey(workspaceId);
  }

  async #verifySnapshotBeforeRotation(workspaceId: string, path: string, expectedSha256: string): Promise<void> {
    const archive = await this.#read(workspaceId, path);
    if (createHash("sha256").update(archive).digest("hex") !== expectedSha256) {
      throw new Error("Staged snapshot verification failed before rotation");
    }
  }

  async #rotateVerifiedSnapshots(
    workspaceId: string,
    paths: { current: string; previous: string; previousBackup: string },
  ): Promise<void> {
    let currentIsValid = false;
    try {
      await this.#read(workspaceId, paths.current);
      currentIsValid = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") await rm(paths.current, { force: true });
    }
    if (!currentIsValid) return;

    await rm(paths.previousBackup, { force: true });
    let previousMoved = false;
    try {
      await rename(paths.previous, paths.previousBackup);
      previousMoved = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    try {
      await rename(paths.current, paths.previous);
    } catch (error) {
      if (previousMoved) await rename(paths.previousBackup, paths.previous).catch(() => undefined);
      throw error;
    }
  }

  #paths(workspaceId: string): { current: string; previous: string; previousBackup: string; staging: string } {
    const name = createHash("sha256").update(workspaceId).digest("hex");
    const directory = join(this.root, name.slice(0, 2), name);
    return {
      current: join(directory, "current.lhs"),
      previous: join(directory, "previous.lhs"),
      previousBackup: join(directory, "previous-backup.lhs"),
      staging: join(directory, `staging-${process.pid}-${randomBytes(6).toString("hex")}.lhs`),
    };
  }
}

export interface WorkspaceLifecycleOwner {
  id: string;
  workspaceId: string;
  appId: string;
  tenantId: string;
  userId: string;
}

export interface WorkspaceLifecycleStore {
  getWorkspace(id: string, owner: Pick<WorkspaceLifecycleOwner, "appId" | "tenantId" | "userId">): WorkspaceRecord | undefined;
  updateWorkspaceState(
    id: string,
    owner: Pick<WorkspaceLifecycleOwner, "appId" | "tenantId" | "userId">,
    expected: WorkspaceRecord["state"],
    state: WorkspaceRecord["state"],
  ): WorkspaceRecord | undefined;
}

export interface WorkspaceLifecycleRuntime {
  workspaceExists(workspaceId: string, principal: InternalPrincipal, signal?: AbortSignal): Promise<boolean>;
  exportWorkspace(workspaceId: string, principal?: InternalPrincipal, signal?: AbortSignal): Promise<Buffer>;
  importWorkspace(workspaceId: string, archive: Buffer, principal?: InternalPrincipal, signal?: AbortSignal): Promise<void>;
  removeWorkspace(workspaceId: string, principal?: InternalPrincipal): Promise<boolean>;
}

export interface WorkspaceCheckpointResult {
  state: "WARM" | "COLD";
  snapshot?: SnapshotRecord;
  skipped: boolean;
}

/** Owns automatic cold restore and post-run checkpoint state transitions. */
export class ManagedWorkspaceLifecycle {
  constructor(
    private readonly store: WorkspaceLifecycleStore,
    private readonly runtime: WorkspaceLifecycleRuntime,
    private readonly snapshots: LocalWorkspaceSnapshotStore,
    private readonly compactor?: SnapshotCompactorQueue,
  ) {}

  close(): void {
    this.compactor?.close();
  }

  async prepare(run: WorkspaceLifecycleOwner, signal?: AbortSignal): Promise<{ restored: boolean; recoveredFromPrevious: boolean }> {
    signal?.throwIfAborted();
    let workspace = this.#workspace(run);
    if (workspace.mode === "registered-bind") return { restored: false, recoveredFromPrevious: false };
    const principal = lifecyclePrincipal(run);
    if (workspace.state === "CORRUPT") throw new Error(`Workspace snapshot is corrupt: ${run.workspaceId}`);
    if (workspace.state === "ERROR") {
      if (await this.runtime.workspaceExists(run.workspaceId, principal, signal)) workspace = this.#transition(run, "ERROR", "WARM");
      else if (this.snapshots.hasCandidates(workspaceSnapshotIdentity(run))) workspace = this.#transition(run, "ERROR", "RESTORING");
      else throw new Error(`Workspace requires recovery: ${run.workspaceId}`);
    }
    if (workspace.state === "IN_USE" || workspace.state === "SNAPSHOTTING") {
      workspace = this.#transition(run, workspace.state, "WARM");
    }
    let restored = false; let recoveredFromPrevious = false;
    const missingWarmVolume = workspace.state === "WARM" && !await this.runtime.workspaceExists(run.workspaceId, principal, signal);
    if (workspace.state === "COLD" || workspace.state === "RESTORING" || (missingWarmVolume && this.snapshots.hasCandidates(workspaceSnapshotIdentity(run)))) {
      const restoreFallbackState: WorkspaceRecord["state"] = workspace.state === "COLD" ? "COLD" : "WARM";
      if (workspace.state !== "RESTORING") workspace = this.#transition(run, workspace.state, "RESTORING");
      try {
        const recovered = await this.snapshots.restore(workspaceSnapshotIdentity(run));
        signal?.throwIfAborted();
        await this.runtime.importWorkspace(run.workspaceId, recovered.archive, principal, signal);
        workspace = this.#transition(run, "RESTORING", "WARM");
        restored = true; recoveredFromPrevious = recovered.recoveredFromPrevious;
      } catch (error) {
        if (signal?.aborted) {
          this.#transition(run, "RESTORING", restoreFallbackState);
          throw error;
        }
        const target = this.snapshots.hasCandidates(workspaceSnapshotIdentity(run)) ? "CORRUPT" : "ERROR";
        this.#transition(run, "RESTORING", target);
        throw error;
      }
    }
    this.#transition(run, workspace.state, "IN_USE");
    return { restored, recoveredFromPrevious };
  }

  async checkpoint(run: WorkspaceLifecycleOwner, options: { makeCold?: boolean; signal?: AbortSignal } = {}): Promise<WorkspaceCheckpointResult> {
    options.signal?.throwIfAborted();
    const workspace = this.#workspace(run);
    if (workspace.mode === "registered-bind") return { state: "WARM", skipped: true };
    this.#transition(run, "IN_USE", "SNAPSHOTTING");
    const principal = lifecyclePrincipal(run);
    try {
      const snapshotJob = async () => {
        const archive = await this.runtime.exportWorkspace(run.workspaceId, principal, options.signal);
        return await this.snapshots.create(workspaceSnapshotIdentity(run), archive);
      };
      const snapshot = this.compactor
        ? await this.compactor.enqueue(workspaceSnapshotIdentity(run), snapshotJob)
        : await snapshotJob();
      if (options.makeCold) {
        await this.runtime.removeWorkspace(run.workspaceId, principal);
        this.#transition(run, "SNAPSHOTTING", "COLD");
        return { state: "COLD", snapshot, skipped: false };
      }
      this.#transition(run, "SNAPSHOTTING", "WARM");
      return { state: "WARM", snapshot, skipped: false };
    } catch (error) {
      this.#transition(run, "SNAPSHOTTING", "ERROR");
      throw error;
    }
  }

  #workspace(run: WorkspaceLifecycleOwner): WorkspaceRecord {
    const workspace = this.store.getWorkspace(run.workspaceId, run);
    if (!workspace) throw new Error(`Workspace is unavailable: ${run.workspaceId}`);
    return workspace;
  }

  #transition(run: WorkspaceLifecycleOwner, expected: WorkspaceRecord["state"], state: WorkspaceRecord["state"]): WorkspaceRecord {
    const updated = this.store.updateWorkspaceState(run.workspaceId, run, expected, state);
    if (!updated) throw new Error(`Workspace state changed while transitioning ${expected} to ${state}`);
    return updated;
  }
}

export function workspaceSnapshotIdentity(owner: Pick<WorkspaceLifecycleOwner, "workspaceId" | "appId" | "tenantId" | "userId">): string {
  return `owned-${createHash("sha256").update(JSON.stringify([owner.appId, owner.tenantId, owner.userId, owner.workspaceId])).digest("hex")}`;
}

function lifecyclePrincipal(owner: WorkspaceLifecycleOwner): InternalPrincipal {
  return { appId: owner.appId, tenantId: owner.tenantId, userId: owner.userId, scopes: [] };
}

export function snapshotAssociatedData(header: SnapshotHeader): Buffer {
  return Buffer.from(`${SNAPSHOT_MAGIC}${JSON.stringify(normalizeSnapshotHeader(header))}\n`);
}

export async function createStreamingSnapshotPipeline(
  archive: Buffer,
  path: string,
  key: Buffer,
  nonce: Buffer,
  header: SnapshotHeader,
): Promise<void> {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(snapshotAssociatedData(header));
  const destination = createWriteStream(path, { flags: "wx", mode: 0o600 });
  if (!destination.write(snapshotAssociatedData(header))) await once(destination, "drain");
  const appendTag = new Transform({
    transform(chunk, _encoding, callback) { callback(null, chunk); },
    flush(callback) {
      try { this.push(cipher.getAuthTag()); callback(); }
      catch (error) { callback(error as Error); }
    },
  });
  try {
    await pipeline(Readable.from(snapshotChunks(archive)), createGzip({ level: 6 }), cipher, appendTag, destination);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

async function readSnapshotDescriptor(path: string, maxArchiveBytes: number): Promise<{
  header: SnapshotHeader;
  ciphertextStart: number;
  ciphertextEnd: number;
  tag: Buffer;
}> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (metadata.size > maxArchiveBytes + 1024 * 1024 || metadata.size < SNAPSHOT_MAGIC.length + SNAPSHOT_TAG_BYTES + 3) {
      throw new Error("Snapshot encoded size is invalid");
    }
    const prefix = Buffer.alloc(Math.min(metadata.size, SNAPSHOT_HEADER_BYTES));
    await handle.read(prefix, 0, prefix.length, 0);
    const firstNewline = prefix.indexOf(0x0a);
    const secondNewline = prefix.indexOf(0x0a, firstNewline + 1);
    if (prefix.subarray(0, firstNewline + 1).toString("utf8") !== SNAPSHOT_MAGIC || secondNewline < 0) {
      throw new Error("Snapshot header is malformed");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(prefix.subarray(firstNewline + 1, secondNewline).toString("utf8")); }
    catch { throw new Error("Snapshot header is malformed"); }
    const header = validateSnapshotHeader(parsed, maxArchiveBytes);
    const ciphertextStart = secondNewline + 1;
    const ciphertextEnd = metadata.size - SNAPSHOT_TAG_BYTES - 1;
    if (ciphertextEnd < ciphertextStart) throw new Error("Snapshot ciphertext is missing");
    const tag = Buffer.alloc(SNAPSHOT_TAG_BYTES);
    await handle.read(tag, 0, tag.length, metadata.size - SNAPSHOT_TAG_BYTES);
    return { header, ciphertextStart, ciphertextEnd, tag };
  } finally {
    await handle.close();
  }
}

function validateSnapshotHeader(value: unknown, maxArchiveBytes: number): SnapshotHeader {
  if (!value || typeof value !== "object") throw new Error("Snapshot header is malformed");
  const record = value as Record<string, unknown>;
  const nonce = typeof record.nonce === "string" ? Buffer.from(record.nonce, "base64") : Buffer.alloc(0);
  if (record.schemaVersion !== 2 || typeof record.workspaceId !== "string" || !record.workspaceId ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isSafeInteger(record.plaintextBytes) || (record.plaintextBytes as number) < 0 ||
      (record.plaintextBytes as number) > maxArchiveBytes || typeof record.sha256 !== "string" ||
       !/^[a-f0-9]{64}$/.test(record.sha256) || nonce.length !== 12 || record.algorithm !== "aes-256-gcm+gzip" ||
       (record.keyVersion !== undefined && record.keyVersion !== 1) ||
       (record.keyScope !== undefined && record.keyScope !== "static" && record.keyScope !== "workspace-derived")) {
    throw new Error("Snapshot identity or version is invalid");
  }
  return normalizeSnapshotHeader(record as unknown as SnapshotHeader);
}

function normalizeSnapshotHeader(header: SnapshotHeader): SnapshotHeader {
  return {
    schemaVersion: 2,
    workspaceId: header.workspaceId,
    createdAt: header.createdAt,
    plaintextBytes: header.plaintextBytes,
    sha256: header.sha256,
    nonce: header.nonce,
    algorithm: "aes-256-gcm+gzip",
    ...(header.keyVersion === undefined ? {} : { keyVersion: header.keyVersion }),
    ...(header.keyScope === undefined ? {} : { keyScope: header.keyScope }),
  };
}

async function* snapshotChunks(archive: Buffer): AsyncIterable<Buffer> {
  const chunkBytes = 64 * 1024;
  for (let offset = 0; offset < archive.length; offset += chunkBytes) {
    yield archive.subarray(offset, Math.min(offset + chunkBytes, archive.length));
    await Promise.resolve();
  }
}

async function collectSnapshotArchive(
  source: ReturnType<typeof createReadStream>,
  decipher: ReturnType<typeof createDecipheriv>,
  expectedBytes: number,
  maxBytes: number,
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  const collector = new Writable({
    write(value: Buffer, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (offset + chunk.length > expectedBytes || offset + chunk.length > maxBytes) {
        callback(new Error("Snapshot expands beyond its declared limit"));
        return;
      }
      chunk.copy(output, offset);
      offset += chunk.length;
      callback();
    },
  });
  await pipeline(source, decipher, createGunzip(), collector);
  if (offset !== expectedBytes) throw new Error("Snapshot plaintext length does not match its header");
  return output;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

interface SnapshotQueueEntry {
  snapshot: (workspaceId: string) => Promise<SnapshotRecord>;
  waiters: Array<{ resolve(value: SnapshotRecord): void; reject(error: unknown): void }>;
}

export class SnapshotCompactorQueue {
  readonly #pending = new Map<string, SnapshotQueueEntry>();
  readonly #active = new Map<string, SnapshotQueueEntry>();
  #running = 0;
  #closed = false;

  constructor(
    private readonly root: string,
    private readonly snapshot: (workspaceId: string) => Promise<SnapshotRecord>,
    private readonly options: { maxConcurrent?: number; maxLoadPerCpu?: number; minFreeBytes?: number } = {},
  ) {}

  enqueue(workspaceId: string, snapshot = this.snapshot): Promise<SnapshotRecord> {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new Error("Snapshot compaction queue is closed"));
        return;
      }
      const entry = this.#active.get(workspaceId) ?? this.#pending.get(workspaceId) ?? { snapshot, waiters: [] };
      entry.waiters.push({ resolve, reject });
      if (this.#active.get(workspaceId) !== entry) this.#pending.set(workspaceId, entry);
      this.#drain();
    });
  }

  get pendingCount(): number { return this.#pending.size; }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Snapshot compaction queue is closed");
    for (const entry of this.#pending.values()) entry.waiters.forEach((waiter) => waiter.reject(error));
    this.#pending.clear();
  }

  #drain(): void {
    if (this.#closed) return;
    const max = this.options.maxConcurrent ?? 1;
    while (this.#running < max && this.#pending.size > 0) {
      const entry = this.#pending.entries().next().value as [string, SnapshotQueueEntry];
      this.#pending.delete(entry[0]); this.#running += 1;
      this.#active.set(entry[0], entry[1]);
      void this.#run(entry[0], entry[1].snapshot).then(
        (record) => entry[1].waiters.forEach((waiter) => waiter.resolve(record)),
        (error) => entry[1].waiters.forEach((waiter) => waiter.reject(error)),
      ).finally(() => { this.#active.delete(entry[0]); this.#running -= 1; this.#drain(); });
    }
  }

  async #run(workspaceId: string, snapshot: (workspaceId: string) => Promise<SnapshotRecord>): Promise<SnapshotRecord> {
    const disk = statfsSync(this.root);
    if (disk.bavail * disk.bsize < (this.options.minFreeBytes ?? 1024 * 1024 * 1024)) throw new Error("Snapshot deferred because disk space is low");
    const cpuCount = Math.max(1, availableParallelism());
    if (loadavg()[0] / cpuCount > (this.options.maxLoadPerCpu ?? 4)) throw new Error("Snapshot deferred because host load is high");
    return await snapshot(workspaceId);
  }
}

export interface ArtifactPayload {
  record: ArtifactRecord;
  data: Buffer;
}

export class LocalArtifactStore {
  readonly #rootKey: Buffer;

  constructor(private readonly root: string, rootKey: Buffer, private readonly maxBytes = 16 * 1024 * 1024) {
    if (rootKey.length !== 32) throw new Error("Artifact root key must be exactly 32 bytes");
    this.#rootKey = Buffer.from(rootKey);
  }

  publish(params: {
    runId: string;
    workspaceId: string;
    principal: InternalPrincipal;
    path: string;
    mediaType: string;
    data: Buffer;
  }): ArtifactRecord {
    validateWorkspacePath(params.path);
    if (params.data.length > this.maxBytes) throw new Error(`Artifact exceeds ${this.maxBytes} bytes`);
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(params.mediaType)) {
      throw new Error("Artifact media type is invalid");
    }
    const id = createId("art");
    const createdAt = new Date().toISOString();
    const record: ArtifactRecord = {
      id,
      runId: params.runId,
      appId: params.principal.appId,
      tenantId: params.principal.tenantId,
      userId: params.principal.userId,
      workspaceId: params.workspaceId,
      path: params.path,
      mediaType: params.mediaType,
      sizeBytes: params.data.length,
      sha256: createHash("sha256").update(params.data).digest("hex"),
      createdAt,
    };
    const paths = this.#paths(id);
    mkdirSync(dirname(paths.data), { recursive: true, mode: 0o700 });
    const staging = `${paths.data}.staging-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(staging, encryptArtifact(record, params.data, this.#rootKey), { flag: "wx", mode: 0o600 });
    const descriptor = openSync(staging, "r+");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const database = this.#database();
    let promoted = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(`
        INSERT INTO artifacts (
          id, run_id, app_id, tenant_id, user_id, workspace_id, path,
          media_type, size_bytes, sha256, created_at, blob_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.runId, record.appId, record.tenantId, record.userId,
        record.workspaceId, record.path, record.mediaType, record.sizeBytes,
        record.sha256, record.createdAt, paths.relative,
      );
      renameSync(staging, paths.data);
      promoted = true;
      database.exec("COMMIT");
      return record;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no open transaction */ }
      if (promoted) rmSync(paths.data, { force: true });
      throw error;
    } finally {
      rmSync(staging, { force: true });
      database.close();
    }
  }

  async publishFromFile(params: {
    runId: string;
    workspaceId: string;
    principal: InternalPrincipal;
    path: string;
    mediaType: string;
    sourcePath: string;
  }): Promise<ArtifactRecord> {
    validateWorkspacePath(params.path);
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(params.mediaType)) {
      throw new Error("Artifact media type is invalid");
    }
    const source = lstatSync(params.sourcePath);
    if (!source.isFile() || source.isSymbolicLink() || source.size > this.maxBytes) {
      throw new Error(`Artifact source must be a regular file no larger than ${this.maxBytes} bytes`);
    }
    const firstDigest = createHash("sha256");
    for await (const chunk of createReadStream(params.sourcePath)) firstDigest.update(chunk as Buffer);
    const record: ArtifactRecord = {
      id: createId("art"), runId: params.runId,
      appId: params.principal.appId, tenantId: params.principal.tenantId, userId: params.principal.userId,
      workspaceId: params.workspaceId, path: params.path, mediaType: params.mediaType,
      sizeBytes: source.size, sha256: firstDigest.digest("hex"), createdAt: new Date().toISOString(),
    };
    const paths = this.#paths(record.id);
    mkdirSync(dirname(paths.data), { recursive: true, mode: 0o700 });
    const staging = `${paths.data}.staging-${process.pid}-${randomBytes(6).toString("hex")}`;
    const header: ArtifactBlobHeader = {
      schemaVersion: 1, id: record.id, nonce: randomBytes(12).toString("base64"), algorithm: "aes-256-gcm+hkdf-sha256",
    };
    const cipher = createCipheriv("aes-256-gcm", artifactDataKey(this.#rootKey, record.id), Buffer.from(header.nonce, "base64"));
    cipher.setAAD(artifactAssociatedData(record, header));
    const verificationDigest = createHash("sha256");
    let verificationBytes = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        verificationBytes += chunk.length;
        verificationDigest.update(chunk);
        callback(null, chunk);
      },
    });
    writeFileSync(staging, `${ARTIFACT_MAGIC}${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
    let promoted = false;
    try {
      await pipeline(createReadStream(params.sourcePath), verifier, cipher, createWriteStream(staging, { flags: "a", mode: 0o600 }));
      appendFileSync(staging, cipher.getAuthTag());
      if (verificationBytes !== record.sizeBytes || verificationDigest.digest("hex") !== record.sha256) {
        throw new Error("Artifact source changed during streaming promotion");
      }
      const descriptor = openSync(staging, "r+");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const database = this.#database();
      try {
        database.exec("BEGIN IMMEDIATE");
        database.prepare(`
          INSERT INTO artifacts (
            id, run_id, app_id, tenant_id, user_id, workspace_id, path,
            media_type, size_bytes, sha256, created_at, blob_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.id, record.runId, record.appId, record.tenantId, record.userId,
          record.workspaceId, record.path, record.mediaType, record.sizeBytes,
          record.sha256, record.createdAt, paths.relative,
        );
        renameSync(staging, paths.data);
        promoted = true;
        database.exec("COMMIT");
        return record;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* no open transaction */ }
        if (promoted) rmSync(paths.data, { force: true });
        throw error;
      } finally {
        database.close();
      }
    } finally {
      rmSync(staging, { force: true });
    }
  }

  async materializeToFile(id: string, principal: InternalPrincipal, destination: string): Promise<ArtifactRecord> {
    const paths = this.#paths(id);
    const database = this.#database();
    let row: ArtifactMetadataRow | undefined;
    try {
      row = database.prepare(`
        SELECT id, run_id, app_id, tenant_id, user_id, workspace_id, path,
               media_type, size_bytes, sha256, created_at, blob_path
        FROM artifacts
        WHERE id = ? AND app_id = ? AND tenant_id = ? AND user_id = ?
      `).get(id, principal.appId, principal.tenantId, principal.userId) as ArtifactMetadataRow | undefined;
    } finally {
      database.close();
    }
    if (!row) throw new Error("Artifact is unavailable or not owned by this principal");
    const record = artifactRecordFromRow(row);
    if (row.blob_path !== paths.relative) throw new Error(`Artifact metadata path is invalid: ${id}`);
    const descriptor = openSync(paths.data, "r");
    let encodedSize: number;
    let headerEnd: number;
    let header: ArtifactBlobHeader;
    let tag: Buffer;
    try {
      encodedSize = fstatSync(descriptor).size;
      if (encodedSize > this.maxBytes + 16 * 1024) throw new Error(`Artifact encoded size is invalid: ${id}`);
      const prefix = Buffer.alloc(Math.min(encodedSize, 4096));
      readSync(descriptor, prefix, 0, prefix.length, 0);
      if (!prefix.subarray(0, ARTIFACT_MAGIC.length).equals(Buffer.from(ARTIFACT_MAGIC))) throw new Error(`Artifact envelope is invalid: ${id}`);
      headerEnd = prefix.indexOf(0x0a, ARTIFACT_MAGIC.length);
      if (headerEnd < 0 || encodedSize < headerEnd + 1 + ARTIFACT_TAG_BYTES) throw new Error(`Artifact envelope is invalid: ${id}`);
      try { header = JSON.parse(prefix.subarray(ARTIFACT_MAGIC.length, headerEnd).toString("utf8")) as ArtifactBlobHeader; }
      catch { throw new Error(`Artifact envelope is invalid: ${id}`); }
      tag = Buffer.alloc(ARTIFACT_TAG_BYTES);
      readSync(descriptor, tag, 0, tag.length, encodedSize - ARTIFACT_TAG_BYTES);
    } finally {
      closeSync(descriptor);
    }
    const nonce = typeof header.nonce === "string" ? Buffer.from(header.nonce, "base64") : Buffer.alloc(0);
    if (header.schemaVersion !== 1 || header.id !== id || nonce.length !== 12 || header.algorithm !== "aes-256-gcm+hkdf-sha256") {
      throw new Error(`Artifact envelope is invalid: ${id}`);
    }
    const decipher = createDecipheriv("aes-256-gcm", artifactDataKey(this.#rootKey, id), nonce);
    decipher.setAAD(artifactAssociatedData(record, header));
    decipher.setAuthTag(tag);
    const digest = createHash("sha256");
    let bytes = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) { bytes += chunk.length; digest.update(chunk); callback(null, chunk); },
    });
    const ciphertext = record.sizeBytes === 0
      ? Readable.from([])
      : createReadStream(paths.data, { start: headerEnd + 1, end: encodedSize - ARTIFACT_TAG_BYTES - 1 });
    try {
      await pipeline(
        ciphertext,
        decipher,
        verifier,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
      if (bytes !== record.sizeBytes || digest.digest("hex") !== record.sha256) throw new Error(`Artifact integrity check failed: ${id}`);
      return record;
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    }
  }

  get(id: string, principal: InternalPrincipal): ArtifactPayload | undefined {
    const paths = this.#paths(id);
    const database = this.#database();
    try {
      const row = database.prepare(`
        SELECT id, run_id, app_id, tenant_id, user_id, workspace_id, path,
               media_type, size_bytes, sha256, created_at, blob_path
        FROM artifacts
        WHERE id = ? AND app_id = ? AND tenant_id = ? AND user_id = ?
      `).get(id, principal.appId, principal.tenantId, principal.userId) as ArtifactMetadataRow | undefined;
      if (!row) return undefined;
      const record = artifactRecordFromRow(row);
      if (row.blob_path !== paths.relative) throw new Error(`Artifact metadata path is invalid: ${id}`);
      const encodedSize = statSync(paths.data).size;
      if (encodedSize > this.maxBytes + 16 * 1024) throw new Error(`Artifact encoded size is invalid: ${id}`);
      const data = decryptArtifact(record, readFileSync(paths.data), this.#rootKey);
      if (data.length !== record.sizeBytes || createHash("sha256").update(data).digest("hex") !== record.sha256) {
        throw new Error(`Artifact integrity check failed: ${id}`);
      }
      return { record, data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      database.close();
    }
  }

  describe(id: string, principal: InternalPrincipal): ArtifactRecord | undefined {
    const paths = this.#paths(id);
    const database = this.#database();
    try {
      const row = database.prepare(`
        SELECT id, run_id, app_id, tenant_id, user_id, workspace_id, path,
               media_type, size_bytes, sha256, created_at, blob_path
        FROM artifacts
        WHERE id = ? AND app_id = ? AND tenant_id = ? AND user_id = ?
      `).get(id, principal.appId, principal.tenantId, principal.userId) as ArtifactMetadataRow | undefined;
      if (!row) return undefined;
      if (row.blob_path !== paths.relative) throw new Error(`Artifact metadata path is invalid: ${id}`);
      return artifactRecordFromRow(row);
    } finally {
      database.close();
    }
  }

  #database(): DatabaseSync {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(join(this.root, "artifacts.sqlite"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        blob_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_owner_idx
        ON artifacts (app_id, tenant_id, user_id, id);
    `);
    return database;
  }

  #paths(id: string): { data: string; relative: string } {
    if (!/^art_[a-f0-9]{32}$/i.test(id)) throw new Error("Invalid artifact identifier");
    const relative = join("blobs", id.slice(4, 6), id, "artifact.lha");
    return { data: join(this.root, relative), relative };
  }
}

interface ArtifactMetadataRow {
  id: string;
  run_id: string;
  app_id: string;
  tenant_id: string;
  user_id: string;
  workspace_id: string;
  path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  blob_path: string;
}

interface ArtifactBlobHeader {
  schemaVersion: 1;
  id: string;
  nonce: string;
  algorithm: "aes-256-gcm+hkdf-sha256";
}

function artifactRecordFromRow(row: ArtifactMetadataRow): ArtifactRecord {
  if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) {
    throw new Error(`Artifact metadata is invalid: ${row.id}`);
  }
  return {
    id: row.id, runId: row.run_id, appId: row.app_id, tenantId: row.tenant_id,
    userId: row.user_id, workspaceId: row.workspace_id, path: row.path,
    mediaType: row.media_type, sizeBytes: row.size_bytes, sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function encryptArtifact(record: ArtifactRecord, data: Buffer, rootKey: Buffer): Buffer {
  const header: ArtifactBlobHeader = {
    schemaVersion: 1,
    id: record.id,
    nonce: randomBytes(12).toString("base64"),
    algorithm: "aes-256-gcm+hkdf-sha256",
  };
  const cipher = createCipheriv("aes-256-gcm", artifactDataKey(rootKey, record.id), Buffer.from(header.nonce, "base64"));
  cipher.setAAD(artifactAssociatedData(record, header));
  return Buffer.concat([
    Buffer.from(`${ARTIFACT_MAGIC}${JSON.stringify(header)}\n`),
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function decryptArtifact(record: ArtifactRecord, encoded: Buffer, rootKey: Buffer): Buffer {
  if (!encoded.subarray(0, ARTIFACT_MAGIC.length).equals(Buffer.from(ARTIFACT_MAGIC))) {
    throw new Error(`Artifact envelope is invalid: ${record.id}`);
  }
  const headerEnd = encoded.indexOf(0x0a, ARTIFACT_MAGIC.length);
  if (headerEnd < 0 || headerEnd > 4096 || encoded.length < headerEnd + 1 + ARTIFACT_TAG_BYTES) {
    throw new Error(`Artifact envelope is invalid: ${record.id}`);
  }
  let header: ArtifactBlobHeader;
  try { header = JSON.parse(encoded.subarray(ARTIFACT_MAGIC.length, headerEnd).toString("utf8")) as ArtifactBlobHeader; }
  catch { throw new Error(`Artifact envelope is invalid: ${record.id}`); }
  const nonce = typeof header.nonce === "string" ? Buffer.from(header.nonce, "base64") : Buffer.alloc(0);
  if (header.schemaVersion !== 1 || header.id !== record.id || nonce.length !== 12 || header.algorithm !== "aes-256-gcm+hkdf-sha256") {
    throw new Error(`Artifact envelope is invalid: ${record.id}`);
  }
  const tagStart = encoded.length - ARTIFACT_TAG_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", artifactDataKey(rootKey, record.id), nonce);
  decipher.setAAD(artifactAssociatedData(record, header));
  decipher.setAuthTag(encoded.subarray(tagStart));
  try { return Buffer.concat([decipher.update(encoded.subarray(headerEnd + 1, tagStart)), decipher.final()]); }
  catch { throw new Error(`Artifact integrity check failed: ${record.id}`); }
}

function artifactDataKey(rootKey: Buffer, id: string): Buffer {
  return Buffer.from(hkdfSync("sha256", rootKey, Buffer.from(id), Buffer.from("lite-harness/artifact/v1"), 32));
}

function artifactAssociatedData(record: ArtifactRecord, header: ArtifactBlobHeader): Buffer {
  return Buffer.from(JSON.stringify({ header, record }));
}

export type CacheClass = "global-immutable" | "tenant-private" | "workspace-private";

export interface CacheDescriptor {
  class: CacheClass;
  kind: string;
  logicalKey: string;
  sourceDigest: string;
  imageDigest: string;
  lockDigest: string;
  toolVersions: Readonly<Record<string, string>>;
  frameworkVersions: Readonly<Record<string, string>>;
  runtimeVersion: string;
  operatingSystem: string;
  architecture: string;
  configDigest: string;
  policyVersion: number;
  tenantId?: string;
  workspaceId?: string;
}

export interface CachePublisher {
  id: string;
  trusted: boolean;
  provenance: string;
  tenantId?: string;
  workspaceId?: string;
}

export interface CachePopulationLease {
  key: string;
  class: CacheClass;
  ownerId: string;
  fencingToken: number;
  stagingPath: string;
  expiresAt: string;
}

export interface CacheReadLease {
  id: string;
  key: string;
  path: string;
  readOnly: true;
  expiresAt: string;
}

export interface CacheGarbageCollectionResult {
  expiredPopulations: number;
  expiredReaders: number;
  evictedEntries: number;
  reclaimedBytes: number;
}

export class LocalCacheCatalog {
  constructor(
    private readonly root: string,
    private readonly limits: { maxEntryBytes?: number; maxFiles?: number } = {},
  ) {}

  resolve(descriptor: CacheDescriptor): { key: string; path: string; class: CacheClass; state: "MISSING" | "STAGING" | "READY" | "QUARANTINED" } {
    validateCacheDescriptor(descriptor);
    const key = cacheKey(descriptor);
    const database = this.#database();
    try {
      const row = database.prepare("SELECT state FROM cache_entries WHERE cache_key = ?").get(key) as { state: "STAGING" | "READY" | "QUARANTINED" } | undefined;
      const state = row?.state ?? "MISSING";
      return { key, path: state === "QUARANTINED" ? this.#quarantinePath(descriptor.class, key) : this.#entryPath(descriptor.class, key), class: descriptor.class, state };
    } finally { database.close(); }
  }

  acquirePopulation(descriptor: CacheDescriptor, publisher: CachePublisher, ttlMs = 60_000): CachePopulationLease {
    validateCacheDescriptor(descriptor);
    validateCachePublisher(descriptor, publisher);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) throw new Error("Cache population lease TTL is invalid");
    const key = cacheKey(descriptor);
    const ownerId = boundedCacheIdentity(publisher.id, "cache publisher id");
    const database = this.#database();
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();
    let fencingToken = 1;
    let stagingPath = "";
    try {
      database.exec("BEGIN IMMEDIATE");
      const entry = database.prepare("SELECT state, fencing_token FROM cache_entries WHERE cache_key = ?").get(key) as { state: string; fencing_token: number } | undefined;
      if (entry?.state === "READY") throw new Error("Cache entry is already ready");
      const active = database.prepare("SELECT owner_id, expires_at, staging_path FROM cache_population_leases WHERE cache_key = ?").get(key) as { owner_id: string; expires_at: string; staging_path: string } | undefined;
      if (active && Date.parse(active.expires_at) > now && active.owner_id !== ownerId) throw new Error("Cache population is leased by another publisher");
      if (active) rmSync(active.staging_path, { recursive: true, force: true });
      fencingToken = (entry?.fencing_token ?? 0) + 1;
      stagingPath = this.#stagingPath(key, fencingToken);
      rmSync(stagingPath, { recursive: true, force: true });
      mkdirSync(stagingPath, { recursive: true, mode: 0o700 });
      database.prepare(`
        INSERT INTO cache_entries (
          cache_key, class, descriptor_json, state, publisher_id, provenance,
          manifest_sha256, size_bytes, file_count, active_readers, fencing_token,
          created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, 'STAGING', ?, ?, NULL, 0, 0, 0, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          state='STAGING', publisher_id=excluded.publisher_id, provenance=excluded.provenance,
          fencing_token=excluded.fencing_token, updated_at=excluded.updated_at
      `).run(key, descriptor.class, JSON.stringify(descriptor), ownerId, publisher.provenance, fencingToken,
        new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
      database.prepare(`
        INSERT INTO cache_population_leases (cache_key, owner_id, fencing_token, staging_path, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET owner_id=excluded.owner_id, fencing_token=excluded.fencing_token,
          staging_path=excluded.staging_path, expires_at=excluded.expires_at
      `).run(key, ownerId, fencingToken, stagingPath, expiresAt);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no transaction */ }
      if (stagingPath) rmSync(stagingPath, { recursive: true, force: true });
      throw error;
    } finally { database.close(); }
    return { key, class: descriptor.class, ownerId, fencingToken, stagingPath, expiresAt };
  }

  stageFile(lease: CachePopulationLease, relativePath: string, data: Buffer): void {
    validateWorkspacePath(relativePath);
    if (data.length > (this.limits.maxEntryBytes ?? 512 * 1024 * 1024)) throw new Error("Cache staged file exceeds the entry limit");
    this.#assertPopulationLease(lease);
    const target = join(lease.stagingPath, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, data, { flag: "wx", mode: 0o600 });
  }

  promote(lease: CachePopulationLease): { key: string; path: string; manifestSha256: string; sizeBytes: number; fileCount: number; readOnly: true } {
    this.#assertPopulationLease(lease);
    const manifest = inspectCacheTree(lease.stagingPath, this.limits.maxEntryBytes ?? 512 * 1024 * 1024, this.limits.maxFiles ?? 100_000);
    const target = this.#entryPath(lease.class, lease.key);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (lstatExists(target)) throw new Error("Cache promotion target already exists");
    renameSync(lease.stagingPath, target);
    chmodCacheTreeReadOnly(target);
    const database = this.#database();
    try {
      database.exec("BEGIN IMMEDIATE");
      const updated = database.prepare(`
        UPDATE cache_entries SET state='READY', manifest_sha256=?, size_bytes=?, file_count=?, updated_at=?, last_used_at=?
        WHERE cache_key=? AND state='STAGING' AND fencing_token=?
      `).run(manifest.sha256, manifest.sizeBytes, manifest.fileCount, new Date().toISOString(), new Date().toISOString(), lease.key, lease.fencingToken);
      if (updated.changes !== 1) throw new Error("Cache population lease lost its fencing authority");
      database.prepare("DELETE FROM cache_population_leases WHERE cache_key=? AND fencing_token=?").run(lease.key, lease.fencingToken);
      database.exec("COMMIT");
      return { key: lease.key, path: target, manifestSha256: manifest.sha256, sizeBytes: manifest.sizeBytes, fileCount: manifest.fileCount, readOnly: true };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no transaction */ }
      rmSync(target, { recursive: true, force: true });
      throw error;
    } finally { database.close(); }
  }

  attachReadOnly(descriptor: CacheDescriptor, scope: { tenantId?: string; workspaceId?: string }, ttlMs = 300_000): CacheReadLease {
    validateCacheDescriptor(descriptor);
    assertCacheScope(descriptor, scope);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) throw new Error("Cache read lease TTL is invalid");
    const key = cacheKey(descriptor);
    this.verify(key);
    const id = `cache_read_${randomBytes(16).toString("hex")}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const database = this.#database();
    try {
      database.exec("BEGIN IMMEDIATE");
      const updated = database.prepare(`
        UPDATE cache_entries SET active_readers=active_readers+1, last_used_at=?, updated_at=?
        WHERE cache_key=? AND state='READY'
      `).run(new Date().toISOString(), new Date().toISOString(), key);
      if (updated.changes !== 1) throw new Error("Cache entry is not ready");
      database.prepare("INSERT INTO cache_read_leases (id, cache_key, expires_at) VALUES (?, ?, ?)").run(id, key, expiresAt);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no transaction */ }
      throw error;
    } finally { database.close(); }
    return { id, key, path: this.#entryPath(descriptor.class, key), readOnly: true, expiresAt };
  }

  releaseRead(lease: Pick<CacheReadLease, "id" | "key">): void {
    const database = this.#database();
    try {
      database.exec("BEGIN IMMEDIATE");
      const removed = database.prepare("DELETE FROM cache_read_leases WHERE id=? AND cache_key=?").run(lease.id, lease.key);
      if (removed.changes === 1) database.prepare("UPDATE cache_entries SET active_readers=MAX(0,active_readers-1), updated_at=? WHERE cache_key=?").run(new Date().toISOString(), lease.key);
      database.exec("COMMIT");
    } catch (error) { try { database.exec("ROLLBACK"); } catch { /* no transaction */ } throw error; }
    finally { database.close(); }
  }

  verify(key: string): void {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Cache key is invalid");
    const database = this.#database();
    try {
      const row = database.prepare("SELECT class, state, manifest_sha256, size_bytes, file_count FROM cache_entries WHERE cache_key=?").get(key) as {
        class: CacheClass; state: string; manifest_sha256: string | null; size_bytes: number; file_count: number;
      } | undefined;
      if (!row || row.state !== "READY" || !row.manifest_sha256) throw new Error("Cache entry is not ready");
      try {
        const manifest = inspectCacheTree(this.#entryPath(row.class, key), this.limits.maxEntryBytes ?? 512 * 1024 * 1024, this.limits.maxFiles ?? 100_000);
        if (manifest.sha256 === row.manifest_sha256 && manifest.sizeBytes === row.size_bytes && manifest.fileCount === row.file_count) return;
      } catch { /* every unreadable or structurally invalid entry is poisoned */ }
      const entryPath = this.#entryPath(row.class, key); const quarantinePath = this.#quarantinePath(row.class, key);
      rmSync(quarantinePath, { recursive: true, force: true });
      mkdirSync(dirname(quarantinePath), { recursive: true, mode: 0o700 });
      if (lstatExists(entryPath)) renameSync(entryPath, quarantinePath);
        database.prepare("UPDATE cache_entries SET state='QUARANTINED', updated_at=? WHERE cache_key=?").run(new Date().toISOString(), key);
      throw new Error("Cache integrity verification failed and the entry was quarantined");
    } finally { database.close(); }
  }

  garbageCollect(options: { quotaBytes: number; maxEntries: number; now?: number }): CacheGarbageCollectionResult {
    if (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes < 0 || !Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0) throw new Error("Cache GC limits are invalid");
    const now = options.now ?? Date.now();
    const database = this.#database();
    let expiredPopulations = 0; let expiredReaders = 0; let evictedEntries = 0; let reclaimedBytes = 0;
    try {
      const populations = database.prepare("SELECT cache_key, staging_path FROM cache_population_leases WHERE expires_at <= ?").all(new Date(now).toISOString()) as Array<{ cache_key: string; staging_path: string }>;
      for (const lease of populations) {
        rmSync(lease.staging_path, { recursive: true, force: true });
        database.prepare("DELETE FROM cache_population_leases WHERE cache_key=?").run(lease.cache_key);
        database.prepare("DELETE FROM cache_entries WHERE cache_key=? AND state='STAGING'").run(lease.cache_key);
        expiredPopulations += 1;
      }
      const readers = database.prepare("SELECT id, cache_key FROM cache_read_leases WHERE expires_at <= ?").all(new Date(now).toISOString()) as Array<{ id: string; cache_key: string }>;
      for (const lease of readers) { this.#releaseReadInDatabase(database, lease.id, lease.cache_key); expiredReaders += 1; }
      const quarantined = database.prepare("SELECT cache_key, class, size_bytes FROM cache_entries WHERE state='QUARANTINED'").all() as Array<{ cache_key: string; class: CacheClass; size_bytes: number }>;
      for (const entry of quarantined) {
        rmSync(this.#quarantinePath(entry.class, entry.cache_key), { recursive: true, force: true });
        database.prepare("DELETE FROM cache_entries WHERE cache_key=? AND state='QUARANTINED'").run(entry.cache_key);
        evictedEntries += 1; reclaimedBytes += entry.size_bytes;
      }
      const ready = database.prepare(`
        SELECT cache_key, class, size_bytes, active_readers FROM cache_entries
        WHERE state='READY' ORDER BY last_used_at ASC, cache_key ASC
      `).all() as Array<{ cache_key: string; class: CacheClass; size_bytes: number; active_readers: number }>;
      let total = ready.reduce((sum, entry) => sum + entry.size_bytes, 0); let count = ready.length;
      for (const entry of ready) {
        if (total <= options.quotaBytes && count <= options.maxEntries) break;
        if (entry.active_readers > 0) continue;
        rmSync(this.#entryPath(entry.class, entry.cache_key), { recursive: true, force: true });
        database.prepare("DELETE FROM cache_entries WHERE cache_key=? AND active_readers=0").run(entry.cache_key);
        total -= entry.size_bytes; count -= 1; evictedEntries += 1; reclaimedBytes += entry.size_bytes;
      }
    } finally { database.close(); }
    return { expiredPopulations, expiredReaders, evictedEntries, reclaimedBytes };
  }

  #assertPopulationLease(lease: CachePopulationLease): void {
    const database = this.#database();
    try {
      const row = database.prepare(`
        SELECT owner_id, fencing_token, staging_path, expires_at FROM cache_population_leases WHERE cache_key=?
      `).get(lease.key) as { owner_id: string; fencing_token: number; staging_path: string; expires_at: string } | undefined;
      if (!row || row.owner_id !== lease.ownerId || row.fencing_token !== lease.fencingToken || row.staging_path !== lease.stagingPath || Date.parse(row.expires_at) <= Date.now()) {
        throw new Error("Cache population lease is stale or invalid");
      }
    } finally { database.close(); }
  }

  #releaseReadInDatabase(database: DatabaseSync, id: string, key: string): void {
    const removed = database.prepare("DELETE FROM cache_read_leases WHERE id=? AND cache_key=?").run(id, key);
    if (removed.changes === 1) database.prepare("UPDATE cache_entries SET active_readers=MAX(0,active_readers-1), updated_at=? WHERE cache_key=?").run(new Date().toISOString(), key);
  }

  #database(): DatabaseSync {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(join(this.root, "cache-catalog.sqlite"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        cache_key TEXT PRIMARY KEY, class TEXT NOT NULL, descriptor_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('STAGING','READY','QUARANTINED')),
        publisher_id TEXT NOT NULL, provenance TEXT NOT NULL, manifest_sha256 TEXT,
        size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, active_readers INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cache_population_leases (
        cache_key TEXT PRIMARY KEY REFERENCES cache_entries(cache_key) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL, staging_path TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cache_read_leases (
        id TEXT PRIMARY KEY, cache_key TEXT NOT NULL REFERENCES cache_entries(cache_key) ON DELETE CASCADE, expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cache_entries_lru_idx ON cache_entries(state,last_used_at);
    `);
    return database;
  }

  #entryPath(cacheClass: CacheClass, key: string): string { return join(this.root, "entries", cacheClass, key.slice(0, 2), key); }
  #quarantinePath(cacheClass: CacheClass, key: string): string { return join(this.root, "quarantine", cacheClass, key.slice(0, 2), key); }
  #stagingPath(key: string, token: number): string { return join(this.root, "staging", key, String(token)); }
}

function cacheKey(descriptor: CacheDescriptor): string {
  const canonical = JSON.stringify({
      class: descriptor.class, kind: descriptor.kind, logicalKey: descriptor.logicalKey,
      sourceDigest: descriptor.sourceDigest, lockDigest: descriptor.lockDigest,
      toolVersions: normalizeCacheVersionMap(descriptor.toolVersions),
      frameworkVersions: normalizeCacheVersionMap(descriptor.frameworkVersions),
      runtimeVersion: descriptor.runtimeVersion, imageDigest: descriptor.imageDigest,
      operatingSystem: descriptor.operatingSystem, architecture: descriptor.architecture,
      configDigest: descriptor.configDigest, policyVersion: descriptor.policyVersion,
      tenantId: descriptor.class === "global-immutable" ? null : descriptor.tenantId,
      workspaceId: descriptor.class === "workspace-private" ? descriptor.workspaceId : null,
    });
  return createHash("sha256").update(canonical).digest("hex");
}

function validateCachePublisher(descriptor: CacheDescriptor, publisher: CachePublisher): void {
  boundedCacheIdentity(publisher.id, "cache publisher id");
  boundedCacheIdentity(publisher.provenance, "cache provenance");
  if (descriptor.class === "global-immutable" && !publisher.trusted) throw new Error("Global cache publication requires a trusted publisher");
  if (descriptor.class !== "global-immutable" && publisher.tenantId !== descriptor.tenantId) throw new Error("Cache publisher tenant does not match the cache scope");
  if (descriptor.class === "workspace-private" && publisher.workspaceId !== descriptor.workspaceId) throw new Error("Cache publisher workspace does not match the cache scope");
}

function assertCacheScope(descriptor: CacheDescriptor, scope: { tenantId?: string; workspaceId?: string }): void {
  if (descriptor.class !== "global-immutable" && descriptor.tenantId !== scope.tenantId) throw new Error("Private cache tenant scope mismatch");
  if (descriptor.class === "workspace-private" && descriptor.workspaceId !== scope.workspaceId) throw new Error("Private cache workspace scope mismatch");
}

function inspectCacheTree(root: string, maxBytes: number, maxFiles: number): { sha256: string; sizeBytes: number; fileCount: number } {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let sizeBytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name); const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Cache tree contains a forbidden file type");
      if (entry.isDirectory()) visit(path);
      else {
        const relativePath = relative(root, path).replaceAll("\\", "/");
        validateWorkspacePath(relativePath);
        sizeBytes += stat.size;
        if (files.length + 1 > maxFiles || sizeBytes > maxBytes) throw new Error("Cache tree exceeds configured limits");
        files.push({ path: relativePath, size: stat.size, sha256: digestCacheFile(path) });
      }
    }
  };
  visit(root);
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), sizeBytes, fileCount: files.length };
}

function digestCacheFile(path: string): string {
  const descriptor = openSync(path, "r"); const digest = createHash("sha256");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) { const bytes = readSync(descriptor, buffer, 0, buffer.length, null); if (!bytes) break; digest.update(buffer.subarray(0, bytes)); }
  } finally { closeSync(descriptor); }
  return digest.digest("hex");
}

function chmodCacheTreeReadOnly(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { chmodCacheTreeReadOnly(path); chmodSync(path, 0o500); }
    else chmodSync(path, 0o400);
  }
  chmodSync(root, 0o500);
}

function lstatExists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function boundedCacheIdentity(value: string, label: string): string { if (!value || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`); return value; }

function validateCacheDescriptor(descriptor: CacheDescriptor): void {
  boundedCacheIdentity(descriptor.kind, "cache kind");
  if (!/^[A-Za-z0-9._/-]{1,256}$/.test(descriptor.logicalKey) || descriptor.logicalKey.includes("..")) throw new Error("Cache logical key is invalid");
  if (!/(?:@sha256:|^sha256:)[a-f0-9]{64}$/.test(descriptor.imageDigest)) throw new Error("Cache image digest must be immutable");
  for (const [label, digest] of [["source", descriptor.sourceDigest], ["lock", descriptor.lockDigest], ["configuration", descriptor.configDigest]] as const) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Cache ${label} digest is invalid`);
  }
  normalizeCacheVersionMap(descriptor.toolVersions);
  normalizeCacheVersionMap(descriptor.frameworkVersions);
  for (const [label, value] of [["runtime version", descriptor.runtimeVersion], ["operating system", descriptor.operatingSystem], ["architecture", descriptor.architecture]] as const) boundedCacheIdentity(value, `cache ${label}`);
  if (!Number.isSafeInteger(descriptor.policyVersion) || descriptor.policyVersion < 1) throw new Error("Cache policy version is invalid");
  if (descriptor.class !== "global-immutable" && !descriptor.tenantId) throw new Error("Private cache requires a tenant");
  if (descriptor.class === "workspace-private" && !descriptor.workspaceId) throw new Error("Workspace cache requires a workspace");
}

function normalizeCacheVersionMap(value: Readonly<Record<string, string>>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cache version metadata is invalid");
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error("Cache version metadata is too large");
  const normalized: Record<string, string> = {};
  for (const [name, version] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z0-9._@/-]{1,128}$/.test(name)) throw new Error("Cache version name is invalid");
    normalized[name] = boundedCacheIdentity(version, `cache version for ${name}`);
  }
  return normalized;
}
