import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  InternalStartRunRequest,
  ApprovalRecord,
  ApprovalStatus,
  RunEvent,
  RunEventType,
  RunRecord,
  RunStatus,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  WorkspaceLease,
} from "@lite-harness/contracts";
import type { AppendRunEvent, RunStore } from "@lite-harness/domain";

interface RunRow {
  id: string;
  idempotency_key: string;
  request_fingerprint: string;
  app_id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  workspace_id: string;
  session_id: string | null;
  input: string;
  status: RunStatus;
  last_sequence: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  run_id: string;
  sequence: number;
  type: RunEventType;
  payload_json: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  app_id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  run_id: string | null;
  role: SessionMessageRole;
  content: string;
  metadata_json: string;
  created_at: string;
}

interface LeaseRow {
  workspace_id: string;
  owner_run_id: string | null;
  fencing_token: number;
  expires_at: string | null;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  status: ApprovalStatus;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    input: row.input,
    status: row.status,
    lastSequence: row.last_sequence,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): RunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): SessionMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    role: row.role,
    content: row.content,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

export class SqliteRunStore implements RunStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (app_id, tenant_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS run_events_cursor
        ON run_events(run_id, sequence);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS session_messages_order
        ON session_messages(session_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workspace_leases (
        workspace_id TEXT PRIMARY KEY,
        owner_run_id TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (1, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (2, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (3, datetime('now'));
    `);
  }

  createOrGetRun(
    id: string,
    request: InternalStartRunRequest,
  ): { run: RunRecord; created: boolean } {
    const fingerprint = requestFingerprint(request);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare(
          `SELECT * FROM runs
           WHERE app_id = ? AND tenant_id = ? AND idempotency_key = ?`,
        )
        .get(request.principal.appId, request.principal.tenantId, request.idempotencyKey) as
        | RunRow
        | undefined;

      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new Error("Idempotency key was reused with a different run request");
        }
        this.#database.exec("COMMIT");
        return { run: toRunRecord(existing), created: false };
      }

      const now = new Date().toISOString();
      const sessionId = request.session ?? `ses_${id.slice(4)}`;
      const session = this.#database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
        | SessionRow
        | undefined;
      if (session) {
        if (
          session.app_id !== request.principal.appId ||
          session.tenant_id !== request.principal.tenantId ||
          session.user_id !== request.principal.userId ||
          session.agent_id !== request.agent
        ) {
          throw new Error("Session does not belong to the requesting principal and agent");
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO sessions(id, app_id, tenant_id, user_id, agent_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            request.principal.appId,
            request.principal.tenantId,
            request.principal.userId,
            request.agent,
            now,
            now,
          );
      }
      this.#database
        .prepare(
          `INSERT INTO runs (
            id, idempotency_key, request_fingerprint, app_id, tenant_id, user_id, agent_id,
            workspace_id, session_id, input, status, last_sequence,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', 1, ?, ?)`,
        )
        .run(
          id,
          request.idempotencyKey,
          fingerprint,
          request.principal.appId,
          request.principal.tenantId,
          request.principal.userId,
          request.agent,
          request.workspace,
          sessionId,
          request.input,
          now,
          now,
        );
      this.#database
        .prepare(
          `INSERT INTO run_events(run_id, sequence, type, payload_json, created_at)
           VALUES (?, 1, 'run.accepted', ?, ?)`,
        )
        .run(id, JSON.stringify({ status: "ACCEPTED" }), now);
      this.#database
        .prepare(
          `INSERT INTO session_messages(id, session_id, run_id, role, content, metadata_json, created_at)
           VALUES (?, ?, ?, 'user', ?, '{}', ?)`,
        )
        .run(`msg_${id.slice(4)}_user`, sessionId, id, request.input, now);
      const row = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow;
      this.#database.exec("COMMIT");
      return { run: toRunRecord(row), created: true };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return row ? toRunRecord(row) : undefined;
  }

  appendEvent(params: AppendRunEvent): RunEvent {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(params.runId) as
        | RunRow
        | undefined;
      if (!row) {
        throw new Error(`Run not found: ${params.runId}`);
      }
      const sequence = row.last_sequence + 1;
      const createdAt = new Date().toISOString();
      const payload = params.payload ?? {};
      this.#database
        .prepare(
          `INSERT INTO run_events(run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(params.runId, sequence, params.type, JSON.stringify(payload), createdAt);
      this.#database
        .prepare(
          `UPDATE runs SET
             status = COALESCE(?, status),
             last_sequence = ?,
             error_code = COALESCE(?, error_code),
             error_message = COALESCE(?, error_message),
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          params.status ?? null,
          sequence,
          params.errorCode ?? null,
          params.errorMessage ?? null,
          createdAt,
          params.runId,
        );
      this.#database.exec("COMMIT");
      return { runId: params.runId, sequence, type: params.type, payload, createdAt };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listEvents(runId: string, after = 0, limit = 1_000): RunEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(runId, after, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  listNonTerminalRuns(): RunRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM runs
         WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ORPHANED')
         ORDER BY created_at ASC`,
      )
      .all() as unknown as RunRow[];
    return rows.map(toRunRecord);
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row ? toSession(row) : undefined;
  }

  appendSessionMessage(params: {
    id: string;
    sessionId: string;
    runId?: string;
    role: SessionMessageRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): SessionMessageRecord {
    const createdAt = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO session_messages(id, session_id, run_id, role, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.sessionId,
        params.runId ?? null,
        params.role,
        params.content,
        JSON.stringify(params.metadata ?? {}),
        createdAt,
      );
    const row = this.#database.prepare("SELECT * FROM session_messages WHERE id = ?").get(params.id) as unknown as MessageRow;
    return toMessage(row);
  }

  listSessionMessages(sessionId: string, limit = 1_000): SessionMessageRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM session_messages WHERE session_id = ?
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  acquireWorkspaceLease(
    workspaceId: string,
    runId: string,
    ttlMs: number,
  ): WorkspaceLease | undefined {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare("SELECT * FROM workspace_leases WHERE workspace_id = ?")
        .get(workspaceId) as LeaseRow | undefined;
      if (row?.owner_run_id && row.owner_run_id !== runId && row.expires_at && row.expires_at > now.toISOString()) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const token = row?.owner_run_id === runId ? row.fencing_token : (row?.fencing_token ?? 0) + 1;
      this.#database
        .prepare(
          `INSERT INTO workspace_leases(workspace_id, owner_run_id, fencing_token, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             owner_run_id = excluded.owner_run_id,
             fencing_token = excluded.fencing_token,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(workspaceId, runId, token, expiresAt, now.toISOString());
      this.#database.exec("COMMIT");
      return { workspaceId, ownerRunId: runId, fencingToken: token, expiresAt };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  validateWorkspaceLease(lease: WorkspaceLease): boolean {
    const row = this.#database
      .prepare("SELECT * FROM workspace_leases WHERE workspace_id = ?")
      .get(lease.workspaceId) as LeaseRow | undefined;
    return Boolean(
      row &&
        row.owner_run_id === lease.ownerRunId &&
        row.fencing_token === lease.fencingToken &&
        row.expires_at &&
        row.expires_at > new Date().toISOString(),
    );
  }

  releaseWorkspaceLease(lease: WorkspaceLease): boolean {
    const result = this.#database
      .prepare(
        `UPDATE workspace_leases SET owner_run_id = NULL, expires_at = NULL, updated_at = ?
         WHERE workspace_id = ? AND owner_run_id = ? AND fencing_token = ?`,
      )
      .run(new Date().toISOString(), lease.workspaceId, lease.ownerRunId, lease.fencingToken);
    return result.changes === 1;
  }

  createApproval(record: ApprovalRecord): ApprovalRecord {
    this.#database.prepare(
      `INSERT INTO approvals(id, run_id, tool_call_id, tool_name, status, expires_at, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id, record.runId, record.toolCallId, record.toolName, record.status,
      record.expiresAt, record.createdAt, record.resolvedAt ?? null,
    );
    return record;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? toApproval(row) : undefined;
  }

  resolveApproval(id: string, status: Exclude<ApprovalStatus, "PENDING">): ApprovalRecord | undefined {
    const resolvedAt = new Date().toISOString();
    this.#database.prepare(
      "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'PENDING'",
    ).run(status, resolvedAt, id);
    return this.getApproval(id);
  }

  close(): void {
    this.#database.close();
  }
}

function requestFingerprint(request: InternalStartRunRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        appId: request.principal.appId,
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        agent: request.agent,
        workspace: request.workspace,
        session: request.session ?? null,
        input: request.input,
      }),
    )
    .digest("hex");
}
