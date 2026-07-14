import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { availableParallelism, loadavg } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  statfsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactRecord, InternalPrincipal } from "@lite-harness/contracts";
import { createId } from "@lite-harness/domain";
import { validateWorkspacePath } from "@lite-harness/runtime";

const SNAPSHOT_MAGIC = "LHS1\n";

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
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const compressed = gzipSync(archive, { level: 6 });
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const header = {
      schemaVersion: 1,
      workspaceId,
      createdAt: new Date().toISOString(),
      plaintextBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      algorithm: "aes-256-gcm+gzip",
    };
    const paths = this.#paths(workspaceId);
    mkdirSync(dirname(paths.current), { recursive: true });
    writeFileSync(paths.staging, Buffer.concat([
      Buffer.from(SNAPSHOT_MAGIC),
      Buffer.from(`${JSON.stringify(header)}\n`),
      ciphertext,
    ]), { mode: 0o600 });
    rmSync(paths.previous, { force: true });
    try {
      renameSync(paths.current, paths.previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(paths.staging, paths.current);
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
      throw new AggregateError([currentError, previousError], `No valid snapshot is available for ${workspaceId}`);
    }
  }

  async #read(workspaceId: string, path: string): Promise<Buffer> {
    const encoded = readFileSync(path);
    const firstNewline = encoded.indexOf(0x0a);
    const secondNewline = encoded.indexOf(0x0a, firstNewline + 1);
    if (encoded.subarray(0, firstNewline + 1).toString("utf8") !== SNAPSHOT_MAGIC || secondNewline < 0) {
      throw new Error("Snapshot header is malformed");
    }
    const header = JSON.parse(encoded.subarray(firstNewline + 1, secondNewline).toString("utf8")) as {
      schemaVersion: number;
      workspaceId: string;
      plaintextBytes: number;
      sha256: string;
      nonce: string;
      tag: string;
      algorithm: string;
    };
    if (header.schemaVersion !== 1 || header.workspaceId !== workspaceId || !["aes-256-gcm", "aes-256-gcm+gzip"].includes(header.algorithm) ||
        !Number.isSafeInteger(header.plaintextBytes) || header.plaintextBytes < 0 || header.plaintextBytes > this.maxArchiveBytes ||
        !/^[a-f0-9]{64}$/.test(header.sha256)) {
      throw new Error("Snapshot identity or version is invalid");
    }
    const key = await this.keys.getKey(workspaceId);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(header.tag, "base64"));
    const decrypted = Buffer.concat([decipher.update(encoded.subarray(secondNewline + 1)), decipher.final()]);
    const archive = header.algorithm === "aes-256-gcm+gzip"
      ? gunzipSync(decrypted, { maxOutputLength: this.maxArchiveBytes })
      : decrypted;
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== header.sha256 || archive.length !== header.plaintextBytes) {
      throw new Error("Snapshot content verification failed");
    }
    return archive;
  }

  #paths(workspaceId: string): { current: string; previous: string; staging: string } {
    const name = createHash("sha256").update(workspaceId).digest("hex");
    const directory = join(this.root, name.slice(0, 2), name);
    return {
      current: join(directory, "current.lhs"),
      previous: join(directory, "previous.lhs"),
      staging: join(directory, `staging-${process.pid}.lhs`),
    };
  }
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
