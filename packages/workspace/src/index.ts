import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
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
  ) {}

  async create(workspaceId: string, archive: Buffer): Promise<SnapshotRecord> {
    const key = await this.keys.getKey(workspaceId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(archive), cipher.final()]);
    const header = {
      schemaVersion: 1,
      workspaceId,
      createdAt: new Date().toISOString(),
      plaintextBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      algorithm: "aes-256-gcm",
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
    if (header.schemaVersion !== 1 || header.workspaceId !== workspaceId || header.algorithm !== "aes-256-gcm") {
      throw new Error("Snapshot identity or version is invalid");
    }
    const key = await this.keys.getKey(workspaceId);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(header.tag, "base64"));
    const archive = Buffer.concat([decipher.update(encoded.subarray(secondNewline + 1)), decipher.final()]);
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

export interface ArtifactPayload {
  record: ArtifactRecord;
  data: Buffer;
}

export class LocalArtifactStore {
  constructor(private readonly root: string) {}

  publish(params: {
    runId: string;
    workspaceId: string;
    principal: InternalPrincipal;
    path: string;
    mediaType: string;
    data: Buffer;
  }): ArtifactRecord {
    validateWorkspacePath(params.path);
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
