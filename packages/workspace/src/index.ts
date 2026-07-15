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
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
import { DatabaseSync } from "node:sqlite";
import type { ArtifactRecord, InternalPrincipal } from "@lite-harness/contracts";
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
