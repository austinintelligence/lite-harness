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

export class SqliteMemoryStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
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

  close(): void {
    this.#database.close();
  }
}
