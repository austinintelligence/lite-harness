import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ordered SQLite migrations", () => {
  it("BD-024-REGRESSION upgrades an actual v1 fixture in order without losing its run", () => {
    const path = temporaryDatabase();
    const database = new DatabaseSync(path);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
        app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT,
        input TEXT NOT NULL, status TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (app_id, tenant_id, idempotency_key)
      );
      CREATE TABLE run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (run_id, sequence)
      );
      CREATE INDEX run_events_cursor ON run_events(run_id, sequence);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
      INSERT INTO runs(
        id, idempotency_key, request_fingerprint, app_id, tenant_id, user_id,
        agent_id, workspace_id, input, status, last_sequence, created_at, updated_at
      ) VALUES (
        'run_fixture', 'fixture-key', 'fixture-fingerprint', 'app', 'tenant', 'user',
        'coder', 'workspace', 'preserve me', 'ACCEPTED', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    database.close();

    const store = new SqliteRunStore(path);
    expect(store.getRun("run_fixture")).toMatchObject({
      id: "run_fixture", input: "preserve me", agentId: "coder", workspaceId: "workspace",
      idempotencyKey: "fixture-key",
    });
    store.close();

    const migrated = new DatabaseSync(path, { readOnly: true });
    const versions = migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
      .map((row) => (row as { version: number }).version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(7);
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  it("fails closed on a gapped or future migration history", () => {
    const path = temporaryDatabase();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (1, '2026-01-01T00:00:00.000Z'),
        (3, '2026-01-01T00:00:00.000Z');
    `);
    database.close();
    expect(() => new SqliteRunStore(path)).toThrow(/non-contiguous/);
  });
});

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "lite-migrations-"));
  roots.push(root);
  return join(root, "fixture.db");
}
