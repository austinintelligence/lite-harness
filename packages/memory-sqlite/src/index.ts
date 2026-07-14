import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface MemoryEntry {
  id: string;
  tenantId: string;
  workspaceId: string;
  markdown: string;
  createdAt: string;
}

export interface VectorMemoryIndex {
  upsert(entry: MemoryEntry): Promise<void>;
  search(scope: { tenantId: string; workspaceId: string }, query: string, limit: number): Promise<Array<{ id: string; score: number }>>;
  remove(scope: { tenantId: string; workspaceId: string }, id: string): Promise<void>;
}

/** Optional vector augmentation; deleting the index leaves exact SQLite memory authoritative. */
export class HybridMemorySearch {
  constructor(private readonly exact: SqliteMemoryStore, private readonly vectors?: VectorMemoryIndex) {}

  async search(tenantId: string, workspaceId: string, query: string, limit = 20): Promise<MemoryEntry[]> {
    const exact = this.exact.search(tenantId, workspaceId, query, limit);
    if (!this.vectors || exact.length >= limit) return exact;
    const seen = new Set(exact.map((entry) => entry.id));
    const semantic = await this.vectors.search({ tenantId, workspaceId }, query, limit);
    for (const match of semantic.sort((left, right) => right.score - left.score)) {
      if (seen.has(match.id)) continue;
      const entry = this.exact.get(tenantId, workspaceId, match.id);
      if (entry) { exact.push(entry); seen.add(entry.id); }
      if (exact.length >= limit) break;
    }
    return exact;
  }
}

export class SqliteMemoryStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED, tenant_id UNINDEXED, workspace_id UNINDEXED, markdown
      );
    `);
  }

  add(tenantId: string, workspaceId: string, markdown: string): MemoryEntry {
    validateScope(tenantId, workspaceId);
    if (!markdown.trim() || Buffer.byteLength(markdown, "utf8") > 256 * 1024) {
      throw new Error("Memory markdown must contain 1-262144 UTF-8 bytes");
    }
    const entry = {
      id: `mem_${randomUUID().replaceAll("-", "")}`,
      tenantId,
      workspaceId,
      markdown,
      createdAt: new Date().toISOString(),
    };
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?)").run(
        entry.id, tenantId, workspaceId, markdown, entry.createdAt,
      );
      this.#database.prepare("INSERT INTO memories_fts VALUES (?, ?, ?, ?)").run(
        entry.id, tenantId, workspaceId, markdown,
      );
      this.#database.exec("COMMIT");
      return entry;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  search(tenantId: string, workspaceId: string, query: string, limit = 20): MemoryEntry[] {
    validateScope(tenantId, workspaceId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Memory search limit must be 1-100");
    const match = query.split(/\s+/).filter(Boolean).map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
    if (!match) return [];
    return this.#database.prepare(`
      SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ? AND f.tenant_id = ? AND f.workspace_id = ?
      ORDER BY rank LIMIT ?
    `).all(match, tenantId, workspaceId, limit).map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: value.id as string,
        tenantId: value.tenant_id as string,
        workspaceId: value.workspace_id as string,
        markdown: value.markdown as string,
        createdAt: value.created_at as string,
      };
    });
  }

  get(tenantId: string, workspaceId: string, id: string): MemoryEntry | undefined {
    validateScope(tenantId, workspaceId);
    const row = this.#database.prepare(
      "SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND workspace_id = ?",
    ).get(id, tenantId, workspaceId) as Record<string, unknown> | undefined;
    return row ? toEntry(row) : undefined;
  }

  remove(tenantId: string, workspaceId: string, id: string): boolean {
    validateScope(tenantId, workspaceId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(
        "DELETE FROM memories WHERE id = ? AND tenant_id = ? AND workspace_id = ?",
      ).run(id, tenantId, workspaceId);
      if (result.changes === 1) this.#database.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
      this.#database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}

function toEntry(value: Record<string, unknown>): MemoryEntry {
  return {
    id: value.id as string,
    tenantId: value.tenant_id as string,
    workspaceId: value.workspace_id as string,
    markdown: value.markdown as string,
    createdAt: value.created_at as string,
  };
}

function validateScope(tenantId: string, workspaceId: string): void {
  if (!tenantId.trim() || !workspaceId.trim() || tenantId.length > 256 || workspaceId.length > 256) {
    throw new Error("Memory tenant and workspace scope are invalid");
  }
}
