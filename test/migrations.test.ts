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
  it("D11 configures the first durable database as SQLite in WAL mode", () => {
    const path = temporaryDatabase();
    const store = new SqliteRunStore(path);
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
    database.close();
  });

  it("D12 persists runs and events across store process-lifetime boundaries", () => {
    const path = temporaryDatabase();
    const first = new SqliteRunStore(path);
    first.createOrGetRun("run-durable", {
      agent: "coder",
      workspace: "workspace-durable",
      input: "persist this run",
      idempotencyKey: "durable-run",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
    });
    first.appendEvent({ runId: "run-durable", type: "run.queued", status: "QUEUED" });
    first.close();

    const reopened = new SqliteRunStore(path);
    expect(reopened.getRun("run-durable")).toMatchObject({
      id: "run-durable", input: "persist this run", status: "QUEUED", lastSequence: 2,
    });
    expect(reopened.listEvents("run-durable")).toMatchObject([
      { sequence: 1, type: "run.accepted" },
      { sequence: 2, type: "run.queued" },
    ]);
    reopened.close();
  });

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
    expect(versions).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
    expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(13);
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM runtime_containers").get()).toEqual({ count: 0 });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM run_route_plans").get()).toEqual({ count: 0 });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM run_model_usage").get()).toEqual({ count: 0 });
    const usageColumns = migrated.prepare("PRAGMA table_info(run_model_usage)").all()
      .map((row) => (row as { name: string }).name);
    expect(usageColumns).toEqual(expect.arrayContaining([
      "cached_input_tokens", "cache_write_input_tokens", "image_input_tokens", "price_snapshot_json",
    ]));
    const approvalColumns = migrated.prepare("PRAGMA table_info(approvals)").all()
      .map((row) => (row as { name: string }).name);
    expect(approvalColumns).toEqual(expect.arrayContaining([
      "tool_arguments_digest", "execution_digest", "app_id", "tenant_id", "user_id",
      "workspace_id", "policy_generation", "route_generation",
    ]));
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
