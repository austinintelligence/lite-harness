import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  webcrypto,
} from "node:crypto";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { createGunzip, createGzip } from "node:zlib";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  statfsSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { once } from "node:events";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactRecord, InternalPrincipal } from "@lite-harness/contracts";
import { createId } from "@lite-harness/domain";
import { validateWorkspacePath } from "@lite-harness/runtime";

const SNAPSHOT_MAGIC = "LHS2\n";
const SNAPSHOT_TAG_BYTES = 16;
const SNAPSHOT_HEADER_BYTES = 16 * 1024;

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
}

export class StaticSnapshotKeyProvider implements SnapshotKeyProvider {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Snapshot key must be exactly 32 bytes");
  }

  async getKey(): Promise<Buffer> {
    return Buffer.from(this.key);
  }
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
}

export class LocalWorkspaceSnapshotStore {
  constructor(
    private readonly root: string,
    private readonly keys: SnapshotKeyProvider,
    private readonly maxArchiveBytes = 512 * 1024 * 1024,
  ) {}

  async create(workspaceId: string, archive: Buffer): Promise<SnapshotRecord> {
    if (archive.length > this.maxArchiveBytes) throw new Error("Workspace snapshot exceeds the archive limit");
    const key = await this.keys.getKey(workspaceId);
    const nonce = randomBytes(12);
    const header: SnapshotHeader = {
      schemaVersion: 2,
      workspaceId,
      createdAt: new Date().toISOString(),
      plaintextBytes: archive.length,
      sha256: Buffer.from(await webcrypto.subtle.digest("SHA-256", archive as unknown as BufferSource)).toString("hex"),
      nonce: nonce.toString("base64"),
      algorithm: "aes-256-gcm+gzip",
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

  async #read(workspaceId: string, path: string): Promise<Buffer> {
    const descriptor = await readSnapshotDescriptor(path, this.maxArchiveBytes);
    const header = descriptor.header;
    if (header.workspaceId !== workspaceId) throw new Error("Snapshot identity or version is invalid");
    const key = await this.keys.getKey(workspaceId);
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
      !/^[a-f0-9]{64}$/.test(record.sha256) || nonce.length !== 12 || record.algorithm !== "aes-256-gcm+gzip") {
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

export class SnapshotCompactorQueue {
  readonly #pending = new Map<string, Array<{ resolve(value: SnapshotRecord): void; reject(error: unknown): void }>>();
  #running = 0;

  constructor(
    private readonly root: string,
    private readonly snapshot: (workspaceId: string) => Promise<SnapshotRecord>,
    private readonly options: { maxConcurrent?: number; maxLoadPerCpu?: number; minFreeBytes?: number } = {},
  ) {}

  enqueue(workspaceId: string): Promise<SnapshotRecord> {
    return new Promise((resolve, reject) => {
      const waiters = this.#pending.get(workspaceId) ?? [];
      waiters.push({ resolve, reject });
      this.#pending.set(workspaceId, waiters);
      this.#drain();
    });
  }

  get pendingCount(): number { return this.#pending.size; }

  #drain(): void {
    const max = this.options.maxConcurrent ?? 1;
    while (this.#running < max && this.#pending.size > 0) {
      const entry = this.#pending.entries().next().value as [string, Array<{ resolve(value: SnapshotRecord): void; reject(error: unknown): void }>];
      this.#pending.delete(entry[0]); this.#running += 1;
      void this.#run(entry[0]).then(
        (record) => entry[1].forEach((waiter) => waiter.resolve(record)),
        (error) => entry[1].forEach((waiter) => waiter.reject(error)),
      ).finally(() => { this.#running -= 1; this.#drain(); });
    }
  }

  async #run(workspaceId: string): Promise<SnapshotRecord> {
    const disk = statfsSync(this.root);
    if (disk.bavail * disk.bsize < (this.options.minFreeBytes ?? 1024 * 1024 * 1024)) throw new Error("Snapshot deferred because disk space is low");
    const cpuCount = Math.max(1, availableParallelism());
    if (loadavg()[0] / cpuCount > (this.options.maxLoadPerCpu ?? 4)) throw new Error("Snapshot deferred because host load is high");
    return await this.snapshot(workspaceId);
  }
}

export interface ArtifactPayload {
  record: ArtifactRecord;
  data: Buffer;
}

export class LocalArtifactStore {
  constructor(private readonly root: string, private readonly maxBytes = 16 * 1024 * 1024) {}

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
    mkdirSync(dirname(paths.data), { recursive: true });
    writeFileSync(paths.data, params.data, { mode: 0o600 });
    writeFileSync(paths.metadata, JSON.stringify(record), { mode: 0o600 });
    return record;
  }

  get(id: string, principal: InternalPrincipal): ArtifactPayload | undefined {
    const paths = this.#paths(id);
    try {
      const record = JSON.parse(readFileSync(paths.metadata, "utf8")) as ArtifactRecord;
      if (
        record.appId !== principal.appId ||
        record.tenantId !== principal.tenantId ||
        record.userId !== principal.userId
      ) return undefined;
      const data = readFileSync(paths.data);
      if (data.length !== record.sizeBytes || createHash("sha256").update(data).digest("hex") !== record.sha256) {
        throw new Error(`Artifact integrity check failed: ${id}`);
      }
      return { record, data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  #paths(id: string): { data: string; metadata: string } {
    if (!/^art_[a-f0-9]{32}$/i.test(id)) throw new Error("Invalid artifact identifier");
    const directory = join(this.root, id.slice(4, 6), id);
    return { data: join(directory, "data"), metadata: join(directory, "metadata.json") };
  }
}

export type CacheClass = "global-immutable" | "tenant-private" | "workspace-private";

export interface CacheDescriptor {
  class: CacheClass;
  logicalKey: string;
  imageDigest: string;
  toolchain: string;
  lockDigest: string;
  tenantId?: string;
  workspaceId?: string;
}

export class LocalCacheCatalog {
  constructor(private readonly root: string) {}

  resolve(descriptor: CacheDescriptor): { key: string; path: string; class: CacheClass } {
    validateCacheDescriptor(descriptor);
    const canonical = JSON.stringify({
      class: descriptor.class, logicalKey: descriptor.logicalKey, imageDigest: descriptor.imageDigest,
      toolchain: descriptor.toolchain, lockDigest: descriptor.lockDigest,
      tenantId: descriptor.class === "global-immutable" ? null : descriptor.tenantId,
      workspaceId: descriptor.class === "workspace-private" ? descriptor.workspaceId : null,
    });
    const key = createHash("sha256").update(canonical).digest("hex");
    const path = join(this.root, descriptor.class, key.slice(0, 2), key);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const metadataPath = join(path, ".lite-cache.json");
    try {
      const existing = JSON.parse(readFileSync(metadataPath, "utf8")) as CacheDescriptor;
      if (JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new Error("Cache key metadata mismatch");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      writeFileSync(metadataPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    }
    return { key, path, class: descriptor.class };
  }
}

function validateCacheDescriptor(descriptor: CacheDescriptor): void {
  if (!/^[A-Za-z0-9._/-]{1,256}$/.test(descriptor.logicalKey) || descriptor.logicalKey.includes("..")) throw new Error("Cache logical key is invalid");
  if (!/(?:@sha256:|^sha256:)[a-f0-9]{64}$/.test(descriptor.imageDigest)) throw new Error("Cache image digest must be immutable");
  if (!descriptor.toolchain.trim() || !/^[a-f0-9]{64}$/.test(descriptor.lockDigest)) throw new Error("Cache toolchain or lock digest is invalid");
  if (descriptor.class !== "global-immutable" && !descriptor.tenantId) throw new Error("Private cache requires a tenant");
  if (descriptor.class === "workspace-private" && !descriptor.workspaceId) throw new Error("Workspace cache requires a workspace");
}
