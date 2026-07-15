import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  InternalStartRunRequest,
  ApprovalRecord,
  ApprovalStatus,
  AgentProfileRecord,
  WorkspaceRecord,
  RunAttemptRecord,
  RunBudget,
  RunUsage,
  RunEvent,
  RunEventType,
  RunRecord,
  RunStatus,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  WorkspaceLease,
} from "@lite-harness/contracts";
import { DEFAULT_RUN_BUDGET } from "@lite-harness/contracts";
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
  parent_run_id: string | null;
  depth: number;
  delivery_allowed: number;
  input: string;
  budget_json: string;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cost_usd: number;
  usage_tool_calls: number;
  status: RunStatus;
  last_sequence: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  version: number;
  app_id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  instructions: string;
  model_capabilities_json: string;
  allowed_tools_json: string;
  default_budget_json: string;
  created_at: string;
}

interface WorkspaceRow {
  id: string;
  app_id: string;
  tenant_id: string;
  user_id: string;
  mode: WorkspaceRecord["mode"];
  state: WorkspaceRecord["state"];
  registered_path: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  run_id: string;
  attempt: number;
  status: RunAttemptRecord["status"];
  started_at: string;
  ended_at: string | null;
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

function scopedIdempotencyKey(userId: string, key: string): string {
  return `${userId.length}:${userId}:${key}`;
}

function publicIdempotencyKey(value: string): string {
  const delimiter = value.indexOf(":");
  if (delimiter < 1) return value;
  const userLength = Number.parseInt(value.slice(0, delimiter), 10);
  if (!Number.isSafeInteger(userLength) || userLength < 0) return value;
  const keyDelimiter = delimiter + 1 + userLength;
  if (value[keyDelimiter] !== ":") return value;
  return value.slice(keyDelimiter + 1);
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    idempotencyKey: publicIdempotencyKey(row.idempotency_key),
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    depth: row.depth ?? 0,
    deliveryAllowed: (row.delivery_allowed ?? 1) === 1,
    input: row.input,
    budget: normalizeBudget(JSON.parse(row.budget_json || "{}") as Partial<RunBudget>),
    usage: {
      inputTokens: row.usage_input_tokens ?? 0,
      outputTokens: row.usage_output_tokens ?? 0,
      costUsd: row.usage_cost_usd ?? 0,
      toolCalls: row.usage_tool_calls ?? 0,
    },
    status: row.status,
    lastSequence: row.last_sequence,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAgentProfile(row: AgentRow): AgentProfileRecord {
  return {
    id: row.id,
    version: row.version,
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    name: row.name,
    instructions: row.instructions,
    modelCapabilities: JSON.parse(row.model_capabilities_json) as string[],
    allowedTools: JSON.parse(row.allowed_tools_json) as string[],
    defaultBudget: normalizeBudget(JSON.parse(row.default_budget_json) as Partial<RunBudget>),
    createdAt: row.created_at,
  };
}

function toWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    mode: row.mode,
    state: row.state,
    ...(row.registered_path ? { registeredPath: row.registered_path } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRow): RunAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
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
    try {
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY CHECK(version > 0),
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const migrations: Array<() => void> = [
      () => this.#database.exec(`
        CREATE TABLE runs (
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
        CREATE TABLE run_events (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
        CREATE INDEX run_events_cursor ON run_events(run_id, sequence);
      `),
      () => this.#database.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE session_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX session_messages_order ON session_messages(session_id, created_at, id);
      `),
      () => this.#database.exec(`
        CREATE TABLE workspace_leases (
          workspace_id TEXT PRIMARY KEY,
          owner_run_id TEXT,
          fencing_token INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE approvals (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
      `),
      () => this.#database.exec(`
        CREATE TABLE agent_profiles (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          app_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          instructions TEXT NOT NULL,
          model_capabilities_json TEXT NOT NULL,
          allowed_tools_json TEXT NOT NULL,
          default_budget_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          state TEXT NOT NULL,
          registered_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `),
      () => {
        this.#database.exec(`
          CREATE TABLE run_attempts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            UNIQUE(run_id, attempt)
          );
        `);
        this.#ensureColumn("runs", "budget_json", "TEXT NOT NULL DEFAULT '{}'");
        this.#ensureColumn("runs", "usage_input_tokens", "INTEGER NOT NULL DEFAULT 0");
        this.#ensureColumn("runs", "usage_output_tokens", "INTEGER NOT NULL DEFAULT 0");
        this.#ensureColumn("runs", "usage_cost_usd", "REAL NOT NULL DEFAULT 0");
        this.#ensureColumn("runs", "usage_tool_calls", "INTEGER NOT NULL DEFAULT 0");
        this.#ensureColumn("runs", "parent_run_id", "TEXT REFERENCES runs(id) ON DELETE SET NULL");
        this.#ensureColumn("runs", "depth", "INTEGER NOT NULL DEFAULT 0");
        this.#ensureColumn("runs", "delivery_allowed", "INTEGER NOT NULL DEFAULT 1");
      },
      () => this.#database.exec(`
        UPDATE runs
        SET idempotency_key = length(user_id) || ':' || user_id || ':' || idempotency_key;
      `),
    ];
    const applied = (this.#database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => row.version);
    if (applied.some((version, index) => version !== index + 1) || applied.length > migrations.length) {
      throw new Error(`Unsupported or non-contiguous SQLite migration history: ${applied.join(",") || "empty"}`);
    }
    for (let index = applied.length; index < migrations.length; index += 1) {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        migrations[index]!();
        this.#database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(index + 1, new Date().toISOString());
        this.#database.exec(`PRAGMA user_version = ${index + 1}`);
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw new Error(`SQLite migration ${index + 1} failed`, { cause: error });
      }
    }
  }

  #ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.#database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createOrGetRun(
    id: string,
    request: InternalStartRunRequest,
  ): { run: RunRecord; created: boolean } {
    const fingerprint = requestFingerprint(request);
    const storedIdempotencyKey = scopedIdempotencyKey(
      request.principal.userId,
      request.idempotencyKey,
    );
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare(
          `SELECT * FROM runs
           WHERE app_id = ? AND tenant_id = ? AND idempotency_key = ?`,
        )
        .get(request.principal.appId, request.principal.tenantId, storedIdempotencyKey) as
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
      if (request.parentRunId) {
        const parent = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(request.parentRunId) as RunRow | undefined;
        if (!parent || !sameOwner(parent, request.principal)) throw new Error("Parent run does not belong to the requesting principal");
        if (request.depth !== (parent.depth ?? 0) + 1) throw new Error("Child run depth is invalid");
      } else if ((request.depth ?? 0) !== 0) {
        throw new Error("Root run depth must be zero");
      }
      const agent = this.#database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(request.agent) as AgentRow | undefined;
      if (agent && !sameOwner(agent, request.principal)) throw new Error("Agent profile does not belong to the requesting principal");
      if (!agent) {
        this.#database.prepare(
          `INSERT INTO agent_profiles(id, version, app_id, tenant_id, user_id, name, instructions,
            model_capabilities_json, allowed_tools_json, default_budget_json, created_at)
           VALUES (?, 1, ?, ?, ?, ?, '', '["text","tools"]', '["read_file","write_file"]', ?, ?)`,
        ).run(
          request.agent, request.principal.appId, request.principal.tenantId, request.principal.userId,
          request.agent, JSON.stringify(DEFAULT_RUN_BUDGET), now,
        );
      }
      const workspace = this.#database.prepare("SELECT * FROM workspaces WHERE id = ?").get(request.workspace) as WorkspaceRow | undefined;
      if (workspace && !sameOwner(workspace, request.principal)) throw new Error("Workspace does not belong to the requesting principal");
      if (!workspace) {
        this.#database.prepare(
          `INSERT INTO workspaces(id, app_id, tenant_id, user_id, mode, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'managed', 'WARM', ?, ?)`,
        ).run(request.workspace, request.principal.appId, request.principal.tenantId, request.principal.userId, now, now);
      }
      const effectiveAgent = agent ?? this.#database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(request.agent) as unknown as AgentRow;
      const budget = normalizeBudget({
        ...JSON.parse(effectiveAgent.default_budget_json) as Partial<RunBudget>,
        ...(request.budget ?? {}),
      });
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
            workspace_id, session_id, parent_run_id, depth, delivery_allowed, input, budget_json, status, last_sequence,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', 1, ?, ?)`,
        )
        .run(
          id,
          storedIdempotencyKey,
          fingerprint,
          request.principal.appId,
          request.principal.tenantId,
          request.principal.userId,
          request.agent,
          request.workspace,
          sessionId,
          request.parentRunId ?? null,
          request.depth ?? 0,
          request.deliveryAllowed === false ? 0 : 1,
          request.input,
          JSON.stringify(budget),
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

  listChildRuns(parentRunId: string): RunRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC, id ASC",
    ).all(parentRunId) as unknown as RunRow[]).map(toRunRecord);
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

  createAgentProfile(record: AgentProfileRecord): AgentProfileRecord {
    this.#database.prepare(
      `INSERT INTO agent_profiles(id, version, app_id, tenant_id, user_id, name, instructions,
        model_capabilities_json, allowed_tools_json, default_budget_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id, record.version, record.appId, record.tenantId, record.userId, record.name,
      record.instructions, JSON.stringify(record.modelCapabilities), JSON.stringify(record.allowedTools),
      JSON.stringify(normalizeBudget(record.defaultBudget)), record.createdAt,
    );
    return this.getAgentProfile(record.id) as AgentProfileRecord;
  }

  getAgentProfile(id: string): AgentProfileRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? toAgentProfile(row) : undefined;
  }

  listAgentProfiles(principal: { appId: string; tenantId: string; userId: string }): AgentProfileRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM agent_profiles WHERE app_id = ? AND tenant_id = ? AND user_id = ? ORDER BY created_at",
    ).all(principal.appId, principal.tenantId, principal.userId) as unknown as AgentRow[]).map(toAgentProfile);
  }

  createWorkspace(record: WorkspaceRecord): WorkspaceRecord {
    this.#database.prepare(
      `INSERT INTO workspaces(id, app_id, tenant_id, user_id, mode, state, registered_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id, record.appId, record.tenantId, record.userId, record.mode, record.state,
      record.registeredPath ?? null, record.createdAt, record.updatedAt,
    );
    return this.getWorkspace(record.id) as WorkspaceRecord;
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  listWorkspaces(principal: { appId: string; tenantId: string; userId: string }): WorkspaceRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM workspaces WHERE app_id = ? AND tenant_id = ? AND user_id = ? ORDER BY created_at",
    ).all(principal.appId, principal.tenantId, principal.userId) as unknown as WorkspaceRow[]).map(toWorkspace);
  }

  createRunAttempt(runId: string, id: string): RunAttemptRecord {
    const count = this.#database.prepare("SELECT COUNT(*) AS count FROM run_attempts WHERE run_id = ?").get(runId) as { count: number };
    const startedAt = new Date().toISOString();
    this.#database.prepare(
      "INSERT INTO run_attempts(id, run_id, attempt, status, started_at) VALUES (?, ?, ?, 'RUNNING', ?)",
    ).run(id, runId, count.count + 1, startedAt);
    return toAttempt(this.#database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(id) as unknown as AttemptRow);
  }

  completeRunAttempt(id: string, status: Exclude<RunAttemptRecord["status"], "RUNNING">): RunAttemptRecord {
    this.#database.prepare(
      "UPDATE run_attempts SET status = ?, ended_at = ? WHERE id = ? AND status = 'RUNNING'",
    ).run(status, new Date().toISOString(), id);
    const row = this.#database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
    if (!row) throw new Error(`Run attempt not found: ${id}`);
    return toAttempt(row);
  }

  completeRunningAttempts(
    runId: string,
    status: Exclude<RunAttemptRecord["status"], "RUNNING">,
  ): number {
    const result = this.#database.prepare(
      "UPDATE run_attempts SET status = ?, ended_at = ? WHERE run_id = ? AND status = 'RUNNING'",
    ).run(status, new Date().toISOString(), runId);
    return Number(result.changes);
  }

  listRunAttempts(runId: string): RunAttemptRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt ASC",
    ).all(runId) as unknown as AttemptRow[]).map(toAttempt);
  }

  recordUsage(runId: string, delta: Partial<RunUsage>): RunRecord {
    this.#database.prepare(
      `UPDATE runs SET usage_input_tokens = usage_input_tokens + ?,
        usage_output_tokens = usage_output_tokens + ?, usage_cost_usd = usage_cost_usd + ?,
        usage_tool_calls = usage_tool_calls + ?, updated_at = ? WHERE id = ?`,
    ).run(
      delta.inputTokens ?? 0, delta.outputTokens ?? 0, delta.costUsd ?? 0, delta.toolCalls ?? 0,
      new Date().toISOString(), runId,
    );
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  close(): void {
    this.#database.close();
  }
}

function requestFingerprint(request: InternalStartRunRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify(canonicalize({
        appId: request.principal.appId,
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        agent: request.agent,
        workspace: request.workspace,
        session: request.session ?? null,
        input: request.input,
        budget: request.budget ?? null,
        parentRunId: request.parentRunId ?? null,
        depth: request.depth ?? 0,
        deliveryAllowed: request.deliveryAllowed ?? true,
      })),
    )
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function normalizeBudget(value: Partial<RunBudget>): RunBudget {
  return {
    maxTurns: value.maxTurns ?? DEFAULT_RUN_BUDGET.maxTurns,
    maxToolCalls: value.maxToolCalls ?? DEFAULT_RUN_BUDGET.maxToolCalls,
    maxInputTokens: value.maxInputTokens ?? DEFAULT_RUN_BUDGET.maxInputTokens,
    maxOutputTokens: value.maxOutputTokens ?? DEFAULT_RUN_BUDGET.maxOutputTokens,
    maxCostUsd: value.maxCostUsd ?? DEFAULT_RUN_BUDGET.maxCostUsd,
    totalTimeoutMs: value.totalTimeoutMs ?? DEFAULT_RUN_BUDGET.totalTimeoutMs,
    modelIdleTimeoutMs: value.modelIdleTimeoutMs ?? DEFAULT_RUN_BUDGET.modelIdleTimeoutMs,
    commandTimeoutMs: value.commandTimeoutMs ?? DEFAULT_RUN_BUDGET.commandTimeoutMs,
  };
}

function sameOwner(
  row: { app_id: string; tenant_id: string; user_id: string },
  principal: { appId: string; tenantId: string; userId: string },
): boolean {
  return row.app_id === principal.appId && row.tenant_id === principal.tenantId && row.user_id === principal.userId;
}
