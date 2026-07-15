import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AccessTokenStore, StoredAccessToken } from "@lite-harness/auth";

interface AccessTokenRow {
  id: string;
  lookup_hash: string;
  secret_hash: string;
  salt: string;
  type: "app" | "run";
  app_id: string;
  tenant_id: string;
  user_id: string;
  scopes_json: string;
  replay_policy: "multi_use" | "resource_bound_multi_use";
  agent_id: string | null;
  workspace_id: string | null;
  budget_ceiling_json: string | null;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  key_generation: number;
}

export class SqliteAccessTokenStore implements AccessTokenStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS access_tokens (
        id TEXT PRIMARY KEY,
        lookup_hash TEXT NOT NULL UNIQUE,
        secret_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('app', 'run')),
        app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        replay_policy TEXT NOT NULL CHECK(replay_policy IN ('multi_use', 'resource_bound_multi_use')),
        agent_id TEXT,
        workspace_id TEXT,
        budget_ceiling_json TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        key_generation INTEGER NOT NULL CHECK(key_generation > 0)
      );
      CREATE INDEX IF NOT EXISTS access_tokens_expiry ON access_tokens(expires_at) WHERE revoked_at IS NULL;
    `);
  }

  getByLookupHash(lookupHash: string): StoredAccessToken | undefined {
    const row = this.#database.prepare("SELECT * FROM access_tokens WHERE lookup_hash = ?").get(lookupHash) as AccessTokenRow | undefined;
    return row ? accessTokenFromRow(row) : undefined;
  }

  getById(id: string): StoredAccessToken | undefined {
    const row = this.#database.prepare("SELECT * FROM access_tokens WHERE id = ?").get(id) as AccessTokenRow | undefined;
    return row ? accessTokenFromRow(row) : undefined;
  }

  latestAppKeyGeneration(appId: string, tenantId: string, userId: string): number {
    const row = this.#database.prepare(
      "SELECT COALESCE(MAX(key_generation), 0) AS generation FROM access_tokens WHERE type = 'app' AND app_id = ? AND tenant_id = ? AND user_id = ?",
    ).get(appId, tenantId, userId) as { generation: number };
    return row.generation;
  }

  put(record: StoredAccessToken): void {
    this.#database.prepare(`
      INSERT INTO access_tokens (
        id, lookup_hash, secret_hash, salt, type, app_id, tenant_id, user_id, scopes_json, replay_policy,
        agent_id, workspace_id, budget_ceiling_json, issued_at, expires_at, revoked_at, key_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.lookupHash, record.secretHash, record.salt, record.type,
      record.appId, record.tenantId, record.userId, JSON.stringify(record.scopes), record.replayPolicy,
      record.agentId ?? null, record.workspaceId ?? null,
      record.budgetCeiling ? JSON.stringify(record.budgetCeiling) : null,
      record.issuedAt, record.expiresAt ?? null, record.revokedAt ?? null, record.keyGeneration,
    );
  }

  rotateApp(record: StoredAccessToken, revokedAt: string): void {
    if (record.type !== "app") throw new Error("Only app credentials can be rotated");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.put(record);
      this.#database.prepare(
        `UPDATE access_tokens SET revoked_at = ?
         WHERE type = 'app' AND app_id = ? AND tenant_id = ? AND user_id = ?
           AND id <> ? AND revoked_at IS NULL`,
      ).run(revokedAt, record.appId, record.tenantId, record.userId, record.id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  revoke(id: string, revokedAt: string): boolean {
    return this.#database.prepare(
      "UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(revokedAt, id).changes === 1;
  }

  close(): void {
    this.#database.close();
  }
}

function accessTokenFromRow(row: AccessTokenRow): StoredAccessToken {
  const scopes = parseStringArray(row.scopes_json, "access token scopes");
  const budget = row.budget_ceiling_json ? parseNumberRecord(row.budget_ceiling_json, "access token budget") : undefined;
  return {
    id: row.id,
    lookupHash: row.lookup_hash,
    secretHash: row.secret_hash,
    salt: row.salt,
    type: row.type,
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    scopes,
    replayPolicy: row.replay_policy,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(budget ? { budgetCeiling: budget } : {}),
    issuedAt: row.issued_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    keyGeneration: row.key_generation,
  };
}

function parseStringArray(value: string, label: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error(`Invalid ${label}`);
  return parsed;
}

function parseNumberRecord(value: string, label: string): Record<string, number> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !Object.values(parsed).every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed as Record<string, number>;
}
