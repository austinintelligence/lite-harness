import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  InternalStartRunRequest,
  ApprovalRecord,
  ApprovalStatus,
  AgentProfileRecord,
  AgentModelCapability,
  WorkspaceRecord,
  RunAttemptRecord,
  RunBudget,
  RunUsage,
  RunEvent,
  RunEventType,
  RunRecord,
  RunSnapshot,
  RunStatus,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  RuntimeContainerRecord,
  RuntimeContainerState,
  RunRoutePlanRecord,
  RunModelUsageRecord,
  WorkspaceLease,
  ProviderConnectionRecord,
} from "@lite-harness/contracts";

export const SQLITE_SCHEMA_VERSION = 16;
import { DEFAULT_RUN_BUDGET } from "@lite-harness/contracts";
import { isTerminalRunStatus } from "@lite-harness/contracts";
import type { AppendRunEvent, ResourceOwner, RunStore } from "@lite-harness/domain";

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
  provider_connection_id: string | null;
  agent_internal_id: string | null;
  workspace_internal_id: string | null;
  session_internal_id: string | null;
  parent_run_id: string | null;
  depth: number;
  delivery_allowed: number;
  input: string;
  budget_json: string;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cost_usd: number;
  usage_tool_calls: number;
  usage_input_tokens_reported: number;
  usage_output_tokens_reported: number;
  usage_cost_reported: number;
  status: RunStatus;
  last_sequence: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  internal_id: string;
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
  internal_id: string;
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

interface RoutePlanRow {
  run_id: string;
  attempt_id: string;
  route_plan_id: string;
  registry_generation: number;
  required_capabilities_json: string;
  selected_model_id: string;
  selected_provider_id: string;
  selected_credential_profile_id: string;
  fallback_model_ids_json: string;
  created_at: string;
}

interface ModelUsageRow {
  id: number;
  run_id: string;
  attempt_id: string;
  route_plan_id: string;
  model_id: string;
  provider_id: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  image_input_tokens: number;
  cost_usd: number | null;
  price_snapshot_json: string | null;
  recorded_at: string;
}

interface EventRow {
  run_id: string;
  sequence: number;
  type: RunEventType;
  payload_json: string;
  created_at: string;
}

interface SessionRow {
  internal_id: string;
  id: string;
  app_id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  agent_internal_id: string;
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

function internalId(prefix: "agt" | "wsp" | "ses"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
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
  tool_arguments_digest: string;
  execution_digest: string;
  app_id: string;
  tenant_id: string;
  user_id: string;
  workspace_id: string;
  policy_generation: number;
  route_generation: string;
  status: ApprovalStatus;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}

interface ProviderConnectionRow {
  internal_id: string;
  id: string;
  app_id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  display_name: string;
  auth_kind: ProviderConnectionRecord["authKind"];
  credential_profile_id: string;
  base_url: string | null;
  model_ids_json: string;
  status: ProviderConnectionRecord["status"];
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
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
    ...(row.provider_connection_id ? { providerConnectionId: row.provider_connection_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    depth: row.depth ?? 0,
    deliveryAllowed: (row.delivery_allowed ?? 1) === 1,
    input: row.input,
    budget: normalizeBudget(JSON.parse(row.budget_json || "{}") as Partial<RunBudget>),
    usage: {
      inputTokens: row.usage_input_tokens_reported === 1 ? row.usage_input_tokens : null,
      outputTokens: row.usage_output_tokens_reported === 1 ? row.usage_output_tokens : null,
      costUsd: row.usage_cost_reported === 1 ? row.usage_cost_usd : null,
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
    modelCapabilities: JSON.parse(row.model_capabilities_json) as AgentModelCapability[],
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

function toRoutePlan(row: RoutePlanRow): RunRoutePlanRecord {
  return {
    runId: row.run_id, attemptId: row.attempt_id, routePlanId: row.route_plan_id,
    registryGeneration: row.registry_generation,
    requiredCapabilities: JSON.parse(row.required_capabilities_json) as AgentModelCapability[],
    selectedModelId: row.selected_model_id, selectedProviderId: row.selected_provider_id,
    selectedCredentialProfileId: row.selected_credential_profile_id,
    fallbackModelIds: JSON.parse(row.fallback_model_ids_json) as string[], createdAt: row.created_at,
  };
}

function toModelUsage(row: ModelUsageRow): RunModelUsageRecord {
  return {
    id: row.id, runId: row.run_id, attemptId: row.attempt_id, routePlanId: row.route_plan_id,
    modelId: row.model_id, providerId: row.provider_id, inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    ...(row.cached_input_tokens ? { cachedInputTokens: row.cached_input_tokens } : {}),
    ...(row.cache_write_input_tokens ? { cacheWriteInputTokens: row.cache_write_input_tokens } : {}),
    ...(row.image_input_tokens ? { imageInputTokens: row.image_input_tokens } : {}),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
    ...(row.price_snapshot_json ? { priceSnapshot: JSON.parse(row.price_snapshot_json) as NonNullable<RunModelUsageRecord["priceSnapshot"]> } : {}),
    recordedAt: row.recorded_at,
  };
}

function toProviderConnection(row: ProviderConnectionRow): ProviderConnectionRecord {
  return {
    id: row.id,
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    providerId: row.provider_id,
    displayName: row.display_name,
    authKind: row.auth_kind,
    credentialProfileId: row.credential_profile_id,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    modelIds: JSON.parse(row.model_ids_json) as string[],
    status: row.status,
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
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
    toolArgumentsDigest: row.tool_arguments_digest,
    executionDigest: row.execution_digest,
    appId: row.app_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    policyGeneration: row.policy_generation,
    routeGeneration: row.route_generation,
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
      () => {
        this.#database.exec(`
          CREATE TABLE agent_profiles_v7 (
            internal_id TEXT PRIMARY KEY,
            id TEXT NOT NULL,
            version INTEGER NOT NULL,
            app_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            instructions TEXT NOT NULL,
            model_capabilities_json TEXT NOT NULL,
            allowed_tools_json TEXT NOT NULL,
            default_budget_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(app_id, tenant_id, user_id, id)
          );
          INSERT INTO agent_profiles_v7
          SELECT 'agt_' || lower(hex(randomblob(16))), id, version, app_id, tenant_id, user_id,
            name, instructions, model_capabilities_json, allowed_tools_json, default_budget_json, created_at
          FROM agent_profiles;
          INSERT INTO agent_profiles_v7
          SELECT 'agt_' || lower(hex(randomblob(16))), r.agent_id, 1, r.app_id, r.tenant_id, r.user_id,
            r.agent_id, '', '["text","tools"]', '["read_file","write_file"]', '{}', MIN(r.created_at)
          FROM runs r
          WHERE NOT EXISTS (
            SELECT 1 FROM agent_profiles_v7 a
            WHERE a.app_id = r.app_id AND a.tenant_id = r.tenant_id
              AND a.user_id = r.user_id AND a.id = r.agent_id
          )
          GROUP BY r.app_id, r.tenant_id, r.user_id, r.agent_id;

          CREATE TABLE workspaces_v7 (
            internal_id TEXT PRIMARY KEY,
            id TEXT NOT NULL,
            app_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            state TEXT NOT NULL,
            registered_path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(app_id, tenant_id, user_id, id)
          );
          INSERT INTO workspaces_v7
          SELECT 'wsp_' || lower(hex(randomblob(16))), id, app_id, tenant_id, user_id, mode, state,
            registered_path, created_at, updated_at
          FROM workspaces;
          INSERT INTO workspaces_v7
          SELECT 'wsp_' || lower(hex(randomblob(16))), r.workspace_id, r.app_id, r.tenant_id, r.user_id,
            'managed', 'WARM', NULL, MIN(r.created_at), MAX(r.updated_at)
          FROM runs r
          WHERE NOT EXISTS (
            SELECT 1 FROM workspaces_v7 w
            WHERE w.app_id = r.app_id AND w.tenant_id = r.tenant_id
              AND w.user_id = r.user_id AND w.id = r.workspace_id
          )
          GROUP BY r.app_id, r.tenant_id, r.user_id, r.workspace_id;

          CREATE TABLE sessions_v7 (
            internal_id TEXT PRIMARY KEY,
            id TEXT NOT NULL,
            app_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_internal_id TEXT NOT NULL REFERENCES agent_profiles_v7(internal_id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(app_id, tenant_id, user_id, id)
          );
          INSERT INTO sessions_v7
          SELECT 'ses_' || lower(hex(randomblob(16))), s.id, s.app_id, s.tenant_id, s.user_id,
            s.agent_id, a.internal_id, s.created_at, s.updated_at
          FROM sessions s
          JOIN agent_profiles_v7 a ON a.app_id = s.app_id AND a.tenant_id = s.tenant_id
            AND a.user_id = s.user_id AND a.id = s.agent_id;
          INSERT INTO sessions_v7
          SELECT 'ses_' || lower(hex(randomblob(16))), r.session_id, r.app_id, r.tenant_id, r.user_id,
            MIN(r.agent_id), MIN(a.internal_id), MIN(r.created_at), MAX(r.updated_at)
          FROM runs r
          JOIN agent_profiles_v7 a ON a.app_id = r.app_id AND a.tenant_id = r.tenant_id
            AND a.user_id = r.user_id AND a.id = r.agent_id
          WHERE r.session_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM sessions_v7 s
            WHERE s.app_id = r.app_id AND s.tenant_id = r.tenant_id
              AND s.user_id = r.user_id AND s.id = r.session_id
          )
          GROUP BY r.app_id, r.tenant_id, r.user_id, r.session_id;

          CREATE TABLE session_messages_v7 (
            id TEXT PRIMARY KEY,
            session_internal_id TEXT NOT NULL REFERENCES sessions_v7(internal_id) ON DELETE CASCADE,
            run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
          );
          INSERT INTO session_messages_v7
          SELECT m.id, scoped.internal_id, m.run_id, m.role, m.content, m.metadata_json, m.created_at
          FROM session_messages m
          JOIN sessions legacy ON legacy.id = m.session_id
          JOIN sessions_v7 scoped ON scoped.app_id = legacy.app_id AND scoped.tenant_id = legacy.tenant_id
            AND scoped.user_id = legacy.user_id AND scoped.id = legacy.id;

          CREATE TABLE workspace_leases_v7 (
            workspace_internal_id TEXT PRIMARY KEY REFERENCES workspaces_v7(internal_id) ON DELETE CASCADE,
            owner_run_id TEXT,
            fencing_token INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT,
            updated_at TEXT NOT NULL
          );
          INSERT INTO workspace_leases_v7
          SELECT w.internal_id, l.owner_run_id, l.fencing_token, l.expires_at, l.updated_at
          FROM workspace_leases l
          JOIN workspaces_v7 w ON w.id = l.workspace_id;

          DROP TABLE session_messages;
          DROP TABLE sessions;
          DROP TABLE workspace_leases;
          DROP TABLE agent_profiles;
          DROP TABLE workspaces;
          ALTER TABLE agent_profiles_v7 RENAME TO agent_profiles;
          ALTER TABLE workspaces_v7 RENAME TO workspaces;
          ALTER TABLE sessions_v7 RENAME TO sessions;
          ALTER TABLE session_messages_v7 RENAME TO session_messages;
          ALTER TABLE workspace_leases_v7 RENAME TO workspace_leases;
          CREATE INDEX session_messages_order ON session_messages(session_internal_id, created_at, id);

          ALTER TABLE runs ADD COLUMN agent_internal_id TEXT REFERENCES agent_profiles(internal_id);
          ALTER TABLE runs ADD COLUMN workspace_internal_id TEXT REFERENCES workspaces(internal_id);
          ALTER TABLE runs ADD COLUMN session_internal_id TEXT REFERENCES sessions(internal_id);
          UPDATE runs SET agent_internal_id = (
            SELECT internal_id FROM agent_profiles a
            WHERE a.app_id = runs.app_id AND a.tenant_id = runs.tenant_id
              AND a.user_id = runs.user_id AND a.id = runs.agent_id
          );
          UPDATE runs SET workspace_internal_id = (
            SELECT internal_id FROM workspaces w
            WHERE w.app_id = runs.app_id AND w.tenant_id = runs.tenant_id
              AND w.user_id = runs.user_id AND w.id = runs.workspace_id
          );
          UPDATE runs SET session_internal_id = (
            SELECT internal_id FROM sessions s
            WHERE s.app_id = runs.app_id AND s.tenant_id = runs.tenant_id
              AND s.user_id = runs.user_id AND s.id = runs.session_id
          ) WHERE session_id IS NOT NULL;
        `);
        const missing = this.#database.prepare(`
          SELECT COUNT(*) AS count FROM runs
          WHERE agent_internal_id IS NULL OR workspace_internal_id IS NULL
            OR (session_id IS NOT NULL AND session_internal_id IS NULL)
        `).get() as { count: number };
        if (missing.count !== 0) throw new Error("Owner-scoped identity migration left unresolved run references");
      },
      () => {
        this.#database.exec(`
          ALTER TABLE session_messages ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
          UPDATE session_messages
          SET sequence = (
            SELECT COUNT(*) FROM session_messages prior
            WHERE prior.session_internal_id = session_messages.session_internal_id
              AND (prior.created_at < session_messages.created_at
                OR (prior.created_at = session_messages.created_at AND prior.id <= session_messages.id))
          );
          CREATE UNIQUE INDEX session_messages_sequence
            ON session_messages(session_internal_id, sequence);
        `);
      },
      () => this.#database.exec(`
        CREATE TABLE runtime_containers (
          runtime_container_id TEXT PRIMARY KEY,
          container_name TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL,
          workspace_identity TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('CREATED', 'RUNNING', 'STOPPING')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX runtime_containers_run ON runtime_containers(run_id, attempt_id);
      `),
      () => {
        this.#ensureColumn("approvals", "tool_arguments_digest", "TEXT NOT NULL DEFAULT 'legacy-unbound'");
        this.#ensureColumn("approvals", "execution_digest", "TEXT NOT NULL DEFAULT 'legacy-unbound'");
        this.#ensureColumn("approvals", "app_id", "TEXT NOT NULL DEFAULT 'legacy-unbound'");
        this.#ensureColumn("approvals", "tenant_id", "TEXT NOT NULL DEFAULT 'legacy-unbound'");
        this.#ensureColumn("approvals", "user_id", "TEXT NOT NULL DEFAULT 'legacy-unbound'");
        this.#ensureColumn("approvals", "workspace_id", "TEXT NOT NULL DEFAULT 'legacy-unbound'");
        this.#ensureColumn("approvals", "policy_generation", "INTEGER NOT NULL DEFAULT 0");
        this.#ensureColumn("approvals", "route_generation", "TEXT NOT NULL DEFAULT 'legacy-unbound'");
        const migratedAt = new Date().toISOString();
        this.#database.prepare(`
          UPDATE approvals
          SET app_id = COALESCE((SELECT app_id FROM runs WHERE runs.id = approvals.run_id), 'legacy-unbound'),
              tenant_id = COALESCE((SELECT tenant_id FROM runs WHERE runs.id = approvals.run_id), 'legacy-unbound'),
              user_id = COALESCE((SELECT user_id FROM runs WHERE runs.id = approvals.run_id), 'legacy-unbound'),
              workspace_id = COALESCE((SELECT workspace_id FROM runs WHERE runs.id = approvals.run_id), 'legacy-unbound'),
              status = CASE WHEN status = 'PENDING' THEN 'EXPIRED' ELSE status END,
              resolved_at = CASE WHEN status = 'PENDING' THEN ? ELSE resolved_at END
          WHERE execution_digest = 'legacy-unbound'
        `).run(migratedAt);
      },
      () => this.#database.exec(`
        CREATE TABLE run_route_plans (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
          route_plan_id TEXT NOT NULL UNIQUE,
          registry_generation INTEGER NOT NULL,
          required_capabilities_json TEXT NOT NULL,
          selected_model_id TEXT NOT NULL,
          selected_provider_id TEXT NOT NULL,
          selected_credential_profile_id TEXT NOT NULL,
          fallback_model_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(run_id, attempt_id)
        ) STRICT;
        CREATE TABLE run_model_usage (
          id INTEGER PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
          route_plan_id TEXT NOT NULL REFERENCES run_route_plans(route_plan_id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
          output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
          cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd >= 0),
          recorded_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX run_model_usage_run ON run_model_usage(run_id, attempt_id, id);
      `),
      () => this.#database.exec(`
        CREATE TABLE run_snapshots (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
          digest TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(run_id, attempt_id),
          UNIQUE(digest)
        ) STRICT;
      `),
      () => {
        this.#ensureColumn("run_model_usage", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_tokens >= 0)");
        this.#ensureColumn("run_model_usage", "cache_write_input_tokens", "INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_input_tokens >= 0)");
        this.#ensureColumn("run_model_usage", "image_input_tokens", "INTEGER NOT NULL DEFAULT 0 CHECK(image_input_tokens >= 0)");
        this.#ensureColumn("run_model_usage", "price_snapshot_json", "TEXT");
      },
      () => this.#database.exec(`
        CREATE TABLE provider_connections (
          internal_id TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          auth_kind TEXT NOT NULL CHECK(auth_kind IN ('api_key', 'oauth', 'delegated_cli', 'local_endpoint')),
          credential_profile_id TEXT NOT NULL,
          base_url TEXT,
          model_ids_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('needs_login', 'ready', 'error', 'revoked')),
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(app_id, tenant_id, user_id, id),
          UNIQUE(app_id, tenant_id, user_id, credential_profile_id)
        ) STRICT;
        CREATE INDEX provider_connections_owner
          ON provider_connections(app_id, tenant_id, user_id, created_at);
      `),
      () => this.#ensureColumn("runs", "provider_connection_id", "TEXT"),
      () => {
        this.#ensureColumn("runs", "usage_input_tokens_reported", "INTEGER NOT NULL DEFAULT 0 CHECK(usage_input_tokens_reported IN (0, 1))");
        this.#ensureColumn("runs", "usage_output_tokens_reported", "INTEGER NOT NULL DEFAULT 0 CHECK(usage_output_tokens_reported IN (0, 1))");
        this.#ensureColumn("runs", "usage_cost_reported", "INTEGER NOT NULL DEFAULT 0 CHECK(usage_cost_reported IN (0, 1))");
        this.#database.exec(`
          UPDATE runs SET
            usage_input_tokens_reported = CASE WHEN usage_input_tokens <> 0 THEN 1 ELSE usage_input_tokens_reported END,
            usage_output_tokens_reported = CASE WHEN usage_output_tokens <> 0 THEN 1 ELSE usage_output_tokens_reported END,
            usage_cost_reported = CASE WHEN usage_cost_usd <> 0 THEN 1 ELSE usage_cost_reported END;
        `);
      },
    ];
    if (migrations.length !== SQLITE_SCHEMA_VERSION) {
      throw new Error(`Storage migration registry has ${migrations.length} entries; expected ${SQLITE_SCHEMA_VERSION}`);
    }
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
      if (request.providerConnectionId) {
        const connection = this.#database.prepare(`
          SELECT * FROM provider_connections
          WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?
        `).get(
          request.principal.appId, request.principal.tenantId, request.principal.userId, request.providerConnectionId,
        ) as ProviderConnectionRow | undefined;
        if (!connection) throw new Error("Provider connection does not belong to the requesting principal");
        if (connection.status !== "ready") throw new Error(`Provider connection is not ready: ${connection.status}`);
      }
      if (request.parentRunId) {
        const parent = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(request.parentRunId) as RunRow | undefined;
        if (!parent || !sameOwner(parent, request.principal)) throw new Error("Parent run does not belong to the requesting principal");
        if (request.depth !== (parent.depth ?? 0) + 1) throw new Error("Child run depth is invalid");
      } else if ((request.depth ?? 0) !== 0) {
        throw new Error("Root run depth must be zero");
      }
      const agent = this.#database.prepare(
        "SELECT * FROM agent_profiles WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
      ).get(
        request.principal.appId, request.principal.tenantId, request.principal.userId, request.agent,
      ) as AgentRow | undefined;
      if (!agent) {
        if (request.createIfMissing === false) throw new Error(`Agent profile is unavailable: ${request.agent}`);
        this.#database.prepare(
          `INSERT INTO agent_profiles(internal_id, id, version, app_id, tenant_id, user_id, name, instructions,
            model_capabilities_json, allowed_tools_json, default_budget_json, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, '', '["text","tools"]', '["read_file","write_file"]', ?, ?)`,
        ).run(
          internalId("agt"), request.agent, request.principal.appId, request.principal.tenantId, request.principal.userId,
          request.agent, JSON.stringify(DEFAULT_RUN_BUDGET), now,
        );
      }
      const workspace = this.#database.prepare(
        "SELECT * FROM workspaces WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
      ).get(
        request.principal.appId, request.principal.tenantId, request.principal.userId, request.workspace,
      ) as WorkspaceRow | undefined;
      if (!workspace) {
        if (request.createIfMissing === false) throw new Error(`Workspace is unavailable: ${request.workspace}`);
        this.#database.prepare(
          `INSERT INTO workspaces(internal_id, id, app_id, tenant_id, user_id, mode, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'managed', 'WARM', ?, ?)`,
        ).run(internalId("wsp"), request.workspace, request.principal.appId, request.principal.tenantId, request.principal.userId, now, now);
      }
      const effectiveAgent = agent ?? this.#database.prepare(
        "SELECT * FROM agent_profiles WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
      ).get(
        request.principal.appId, request.principal.tenantId, request.principal.userId, request.agent,
      ) as unknown as AgentRow;
      const effectiveWorkspace = workspace ?? this.#database.prepare(
        "SELECT * FROM workspaces WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
      ).get(
        request.principal.appId, request.principal.tenantId, request.principal.userId, request.workspace,
      ) as unknown as WorkspaceRow;
      const budget = normalizeBudget({
        ...JSON.parse(effectiveAgent.default_budget_json) as Partial<RunBudget>,
        ...(request.budget ?? {}),
      });
      const sessionId = request.session ?? `ses_${id.slice(4)}`;
      const session = this.#database.prepare(
        "SELECT * FROM sessions WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
      ).get(
        request.principal.appId, request.principal.tenantId, request.principal.userId, sessionId,
      ) as
        | SessionRow
        | undefined;
      if (session) {
        if (session.agent_internal_id !== effectiveAgent.internal_id) {
          throw new Error("Session does not belong to the requesting principal and agent");
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO sessions(internal_id, id, app_id, tenant_id, user_id, agent_id, agent_internal_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            internalId("ses"),
            sessionId,
            request.principal.appId,
            request.principal.tenantId,
            request.principal.userId,
            request.agent,
            effectiveAgent.internal_id,
            now,
            now,
          );
      }
      const effectiveSession = session ?? this.#database.prepare(
        "SELECT * FROM sessions WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
      ).get(
        request.principal.appId, request.principal.tenantId, request.principal.userId, sessionId,
      ) as unknown as SessionRow;
      const sessionWorkspaces = this.#database.prepare(
        `SELECT DISTINCT workspace_internal_id
         FROM runs
         WHERE session_internal_id = ? AND workspace_internal_id IS NOT NULL`,
      ).all(effectiveSession.internal_id) as Array<{ workspace_internal_id: string }>;
      const boundWorkspaceIds = new Set(sessionWorkspaces.map((row) => row.workspace_internal_id));
      if (boundWorkspaceIds.size > 1 || (boundWorkspaceIds.size === 1 && !boundWorkspaceIds.has(effectiveWorkspace.internal_id))) {
        throw new Error("Session is bound to a different workspace; use a new session for this workspace");
      }
      this.#database
        .prepare(
          `INSERT INTO runs (
            id, idempotency_key, request_fingerprint, app_id, tenant_id, user_id, agent_id,
            workspace_id, session_id, provider_connection_id, agent_internal_id, workspace_internal_id, session_internal_id,
            parent_run_id, depth, delivery_allowed, input, budget_json, status, last_sequence,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', 1, ?, ?)`,
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
          request.providerConnectionId ?? null,
          effectiveAgent.internal_id,
          effectiveWorkspace.internal_id,
          effectiveSession.internal_id,
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
          `INSERT INTO session_messages(
             id, session_internal_id, run_id, role, content, metadata_json, created_at, sequence
           ) VALUES (?, ?, ?, 'user', ?, '{}', ?,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_messages WHERE session_internal_id = ?)
           )`,
        )
        .run(
          `msg_${id.slice(4)}_user`, effectiveSession.internal_id, id, request.input, now,
          effectiveSession.internal_id,
        );
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

  listRuns(principal: ResourceOwner, limit = 100): RunRecord[] {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1_000) : 100;
    return (this.#database.prepare(
      `SELECT * FROM runs
       WHERE app_id = ? AND tenant_id = ? AND user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(principal.appId, principal.tenantId, principal.userId, boundedLimit) as unknown as RunRow[]).map(toRunRecord);
  }

  listChildRuns(parentRunId: string): RunRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC, id ASC",
    ).all(parentRunId) as unknown as RunRow[]).map(toRunRecord);
  }

  appendEvent(params: AppendRunEvent): RunEvent {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const event = this.#appendEventWithinTransaction(params);
      this.#database.exec("COMMIT");
      return event;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #appendEventWithinTransaction(params: AppendRunEvent): RunEvent {
    const row = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(params.runId) as
      | RunRow
      | undefined;
    if (!row) {
      throw new Error(`Run not found: ${params.runId}`);
    }
    const payload = params.payload ?? {};
    const childRunId = typeof payload.childRunId === "string" ? payload.childRunId : undefined;
    const child = childRunId
      ? this.#database.prepare("SELECT id, parent_run_id, status FROM runs WHERE id = ?").get(childRunId) as
        { id: string; parent_run_id: string | null; status: RunStatus } | undefined
      : undefined;
    const detachedSubagentSummary = params.type === "subagent.completed" &&
      params.status === undefined && params.errorCode === undefined && params.errorMessage === undefined &&
      params.usage === undefined && child?.parent_run_id === params.runId &&
      isTerminalRunStatus(child.status) && payload.status === child.status;
    if (params.type === "subagent.completed" && !detachedSubagentSummary) {
      throw new Error(`Invalid detached subagent summary for run ${params.runId}`);
    }
    if (isTerminalRunStatus(row.status) && !detachedSubagentSummary) {
      throw new Error(`Run ${params.runId} is terminal; cannot append event ${params.type}`);
    }
    // Detached subagents may finish after their parent run has terminalized.
    // Their completion is an append-only informational summary; it cannot
    // change parent status, usage, errors, or attempt state.
    const sequence = row.last_sequence + 1;
    const createdAt = new Date().toISOString();
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
           usage_input_tokens = CASE WHEN ? IS NULL THEN usage_input_tokens ELSE usage_input_tokens + ? END,
           usage_input_tokens_reported = CASE WHEN ? IS NULL THEN usage_input_tokens_reported ELSE 1 END,
           usage_output_tokens = CASE WHEN ? IS NULL THEN usage_output_tokens ELSE usage_output_tokens + ? END,
           usage_output_tokens_reported = CASE WHEN ? IS NULL THEN usage_output_tokens_reported ELSE 1 END,
           usage_cost_usd = CASE WHEN ? IS NULL THEN usage_cost_usd ELSE usage_cost_usd + ? END,
           usage_cost_reported = CASE WHEN ? IS NULL THEN usage_cost_reported ELSE 1 END,
           usage_tool_calls = usage_tool_calls + ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        params.status ?? null,
        sequence,
        params.errorCode ?? null,
        params.errorMessage ?? null,
        params.usage?.inputTokens ?? null, params.usage?.inputTokens ?? 0, params.usage?.inputTokens ?? null,
        params.usage?.outputTokens ?? null, params.usage?.outputTokens ?? 0, params.usage?.outputTokens ?? null,
        params.usage?.costUsd ?? null, params.usage?.costUsd ?? 0, params.usage?.costUsd ?? null,
        params.usage?.toolCalls ?? 0,
        createdAt,
        params.runId,
      );
    if (params.status && isTerminalRunStatus(params.status)) {
      this.#database.prepare(
        "UPDATE run_attempts SET status = ?, ended_at = ? WHERE run_id = ? AND status = 'RUNNING'",
      ).run(params.status, createdAt, params.runId);
    }
    return { runId: params.runId, sequence, type: params.type, payload, createdAt };
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

  getLastEvent(runId: string, type?: RunEventType): RunEvent | undefined {
    const row = this.#database.prepare(
      `SELECT * FROM run_events
       WHERE run_id = ?${type ? " AND type = ?" : ""}
       ORDER BY sequence DESC LIMIT 1`,
    ).get(...(type ? [runId, type] : [runId])) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
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

  getSession(id: string, owner: ResourceOwner): SessionRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM sessions WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
    ).get(owner.appId, owner.tenantId, owner.userId, id) as
      | SessionRow
      | undefined;
    return row ? toSession(row) : undefined;
  }

  appendSessionMessage(params: {
    id: string;
    sessionId: string;
    runId: string;
    role: SessionMessageRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): SessionMessageRecord {
    const createdAt = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(params.runId) as RunRow | undefined;
      if (!run || !run.session_internal_id || run.session_id !== params.sessionId) {
        throw new Error("Session message does not belong to the supplied run");
      }
      if (isTerminalRunStatus(run.status)) {
        throw new Error(`Run ${params.runId} is terminal; cannot append a session message`);
      }
      const next = this.#database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM session_messages WHERE session_internal_id = ?",
      ).get(run.session_internal_id) as { sequence: number };
      this.#database
        .prepare(
          `INSERT INTO session_messages(
             id, session_internal_id, run_id, role, content, metadata_json, created_at, sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.id,
          run.session_internal_id,
          params.runId,
          params.role,
          params.content,
          JSON.stringify(params.metadata ?? {}),
          createdAt,
          next.sequence,
        );
      const row = this.#database.prepare(
        `SELECT m.*, s.id AS session_id FROM session_messages m
         JOIN sessions s ON s.internal_id = m.session_internal_id WHERE m.id = ?`,
      ).get(params.id) as unknown as MessageRow;
      this.#database.exec("COMMIT");
      return toMessage(row);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listSessionMessages(sessionId: string, owner: ResourceOwner, limit = 1_000): SessionMessageRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT m.*, s.id AS session_id FROM session_messages m
           JOIN sessions s ON s.internal_id = m.session_internal_id
           WHERE s.app_id = ? AND s.tenant_id = ? AND s.user_id = ? AND s.id = ?
           ORDER BY m.sequence DESC LIMIT ?
         ) newest
         ORDER BY sequence ASC`,
      )
      .all(owner.appId, owner.tenantId, owner.userId, sessionId, limit) as unknown as MessageRow[];
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
      const run = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
      if (!run?.workspace_internal_id || run.workspace_id !== workspaceId) {
        throw new Error("Workspace lease does not belong to the supplied run");
      }
      const row = this.#database
        .prepare("SELECT workspace_internal_id AS workspace_id, owner_run_id, fencing_token, expires_at FROM workspace_leases WHERE workspace_internal_id = ?")
        .get(run.workspace_internal_id) as LeaseRow | undefined;
      if (row?.owner_run_id && row.owner_run_id !== runId && row.expires_at && row.expires_at > now.toISOString()) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const sameLiveOwner = row?.owner_run_id === runId && row.expires_at && row.expires_at > now.toISOString();
      const token = sameLiveOwner ? (row?.fencing_token ?? 0) : (row?.fencing_token ?? 0) + 1;
      this.#database
        .prepare(
          `INSERT INTO workspace_leases(workspace_internal_id, owner_run_id, fencing_token, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(workspace_internal_id) DO UPDATE SET
             owner_run_id = excluded.owner_run_id,
             fencing_token = excluded.fencing_token,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(run.workspace_internal_id, runId, token, expiresAt, now.toISOString());
      this.#database.exec("COMMIT");
      return { workspaceId, ownerRunId: runId, fencingToken: token, expiresAt };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkspaceLease(workspaceId: string, runId: string): WorkspaceLease | undefined {
    const row = this.#database.prepare(`
      SELECT l.workspace_internal_id AS workspace_id, l.owner_run_id, l.fencing_token, l.expires_at
      FROM workspace_leases l
      JOIN runs r ON r.workspace_internal_id = l.workspace_internal_id
      WHERE r.id = ? AND r.workspace_id = ? AND l.owner_run_id = ?
    `).get(runId, workspaceId, runId) as LeaseRow | undefined;
    return row ? {
      workspaceId,
      ownerRunId: row.owner_run_id as string,
      fencingToken: row.fencing_token,
      expiresAt: row.expires_at as string,
    } : undefined;
  }

  validateWorkspaceLease(lease: WorkspaceLease): boolean {
    const row = this.#database
      .prepare(`SELECT l.workspace_internal_id AS workspace_id, l.owner_run_id, l.fencing_token, l.expires_at
        FROM workspace_leases l JOIN runs r ON r.workspace_internal_id = l.workspace_internal_id
        WHERE r.id = ? AND r.workspace_id = ?`)
      .get(lease.ownerRunId, lease.workspaceId) as LeaseRow | undefined;
    return Boolean(
      row &&
        row.owner_run_id === lease.ownerRunId &&
        row.fencing_token === lease.fencingToken &&
        row.expires_at &&
        row.expires_at > new Date().toISOString(),
    );
  }

  renewWorkspaceLease(lease: WorkspaceLease, ttlMs: number): WorkspaceLease | undefined {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const result = this.#database.prepare(
      `UPDATE workspace_leases SET expires_at = ?, updated_at = ?
       WHERE workspace_internal_id = (
         SELECT workspace_internal_id FROM runs WHERE id = ? AND workspace_id = ?
       ) AND owner_run_id = ? AND fencing_token = ? AND expires_at > ?`,
    ).run(
      expiresAt, now.toISOString(), lease.ownerRunId, lease.workspaceId,
      lease.ownerRunId, lease.fencingToken, now.toISOString(),
    );
    return result.changes === 1 ? { ...lease, expiresAt } : undefined;
  }

  releaseWorkspaceLease(lease: WorkspaceLease): boolean {
    const result = this.#database
      .prepare(
        `UPDATE workspace_leases SET owner_run_id = NULL, expires_at = NULL, updated_at = ?
         WHERE workspace_internal_id = (SELECT workspace_internal_id FROM runs WHERE id = ? AND workspace_id = ?)
           AND owner_run_id = ? AND fencing_token = ?`,
      )
      .run(new Date().toISOString(), lease.ownerRunId, lease.workspaceId, lease.ownerRunId, lease.fencingToken);
    return result.changes === 1;
  }

  createApproval(record: ApprovalRecord): ApprovalRecord {
    this.#database.prepare(
      `INSERT INTO approvals(
         id, run_id, tool_call_id, tool_name, tool_arguments_digest, execution_digest,
         app_id, tenant_id, user_id, workspace_id, policy_generation, route_generation,
         status, expires_at, created_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id, record.runId, record.toolCallId, record.toolName,
      record.toolArgumentsDigest, record.executionDigest,
      record.appId, record.tenantId, record.userId, record.workspaceId,
      record.policyGeneration, record.routeGeneration, record.status,
      record.expiresAt, record.createdAt, record.resolvedAt ?? null,
    );
    return record;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? toApproval(row) : undefined;
  }

  resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, "PENDING">,
    expectedExecutionDigest: string,
  ): ApprovalRecord | undefined {
    const resolvedAt = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#resolveApprovalWithinTransaction(id, status, expectedExecutionDigest, resolvedAt);
      const record = this.getApproval(id);
      this.#database.exec("COMMIT");
      return record;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  resolveApprovalAndAppendEvent(
    id: string,
    status: Exclude<ApprovalStatus, "PENDING">,
    expectedExecutionDigest: string,
    payload: Record<string, unknown>,
  ): ApprovalRecord | undefined {
    const resolvedAt = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.#resolveApprovalWithinTransaction(id, status, expectedExecutionDigest, resolvedAt);
      const record = this.getApproval(id);
      if (changed && record) {
        this.#appendEventWithinTransaction({
          runId: record.runId,
          type: "approval.resolved",
          payload,
        });
      }
      this.#database.exec("COMMIT");
      return record;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #resolveApprovalWithinTransaction(
    id: string,
    status: Exclude<ApprovalStatus, "PENDING">,
    expectedExecutionDigest: string,
    resolvedAt: string,
  ): boolean {
    const result = this.#database.prepare(
      `UPDATE approvals SET status = ?, resolved_at = ?
       WHERE id = ? AND status = 'PENDING' AND execution_digest = ?
         AND (? != 'APPROVED' OR expires_at > ?)
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE runs.id = approvals.run_id
             AND runs.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ORPHANED')
         )`,
    ).run(status, resolvedAt, id, expectedExecutionDigest, status, resolvedAt);
    return Number(result.changes) === 1;
  }

  createAgentProfile(record: AgentProfileRecord): AgentProfileRecord {
    this.#database.prepare(
      `INSERT INTO agent_profiles(internal_id, id, version, app_id, tenant_id, user_id, name, instructions,
        model_capabilities_json, allowed_tools_json, default_budget_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      internalId("agt"), record.id, record.version, record.appId, record.tenantId, record.userId, record.name,
      record.instructions, JSON.stringify(record.modelCapabilities), JSON.stringify(record.allowedTools),
      JSON.stringify(normalizeBudget(record.defaultBudget)), record.createdAt,
    );
    return this.getAgentProfile(record.id, record) as AgentProfileRecord;
  }

  getAgentProfile(id: string, owner: ResourceOwner): AgentProfileRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM agent_profiles WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
    ).get(owner.appId, owner.tenantId, owner.userId, id) as AgentRow | undefined;
    return row ? toAgentProfile(row) : undefined;
  }

  listAgentProfiles(principal: { appId: string; tenantId: string; userId: string }): AgentProfileRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM agent_profiles WHERE app_id = ? AND tenant_id = ? AND user_id = ? ORDER BY created_at",
    ).all(principal.appId, principal.tenantId, principal.userId) as unknown as AgentRow[]).map(toAgentProfile);
  }

  deleteAgentProfile(id: string, owner: ResourceOwner): boolean {
    const result = this.#database.prepare(`
      DELETE FROM agent_profiles
      WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?
        AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.agent_internal_id = agent_profiles.internal_id)
        AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.agent_internal_id = agent_profiles.internal_id)
    `).run(owner.appId, owner.tenantId, owner.userId, id);
    return Number(result.changes) === 1;
  }

  createWorkspace(record: WorkspaceRecord): WorkspaceRecord {
    this.#database.prepare(
      `INSERT INTO workspaces(internal_id, id, app_id, tenant_id, user_id, mode, state, registered_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      internalId("wsp"), record.id, record.appId, record.tenantId, record.userId, record.mode, record.state,
      record.registeredPath ?? null, record.createdAt, record.updatedAt,
    );
    return this.getWorkspace(record.id, record) as WorkspaceRecord;
  }

  getWorkspace(id: string, owner: ResourceOwner): WorkspaceRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM workspaces WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?",
    ).get(owner.appId, owner.tenantId, owner.userId, id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  listWorkspaces(principal: { appId: string; tenantId: string; userId: string }): WorkspaceRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM workspaces WHERE app_id = ? AND tenant_id = ? AND user_id = ? ORDER BY created_at",
    ).all(principal.appId, principal.tenantId, principal.userId) as unknown as WorkspaceRow[]).map(toWorkspace);
  }

  updateWorkspaceState(id: string, owner: ResourceOwner, expected: WorkspaceRecord["state"], state: WorkspaceRecord["state"]): WorkspaceRecord | undefined {
    const updatedAt = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE workspaces SET state = ?, updated_at = ?
      WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ? AND state = ?
    `).run(state, updatedAt, owner.appId, owner.tenantId, owner.userId, id, expected);
    return result.changes === 1 ? this.getWorkspace(id, owner) : undefined;
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

  persistRunRoutePlan(record: RunRoutePlanRecord): RunRoutePlanRecord {
    const existing = this.getRunRoutePlan(record.runId, record.attemptId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("A run attempt route plan is already frozen");
      return existing;
    }
    this.#database.prepare(`
      INSERT INTO run_route_plans(
        run_id, attempt_id, route_plan_id, registry_generation, required_capabilities_json,
        selected_model_id, selected_provider_id, selected_credential_profile_id,
        fallback_model_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runId, record.attemptId, record.routePlanId, record.registryGeneration,
      JSON.stringify(record.requiredCapabilities), record.selectedModelId, record.selectedProviderId,
      record.selectedCredentialProfileId, JSON.stringify(record.fallbackModelIds), record.createdAt,
    );
    return this.getRunRoutePlan(record.runId, record.attemptId) as RunRoutePlanRecord;
  }

  getRunRoutePlan(runId: string, attemptId: string): RunRoutePlanRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM run_route_plans WHERE run_id = ? AND attempt_id = ?",
    ).get(runId, attemptId) as RoutePlanRow | undefined;
    return row ? toRoutePlan(row) : undefined;
  }

  persistRunSnapshot(snapshot: RunSnapshot): RunSnapshot {
    const existing = this.getRunSnapshot(snapshot.runId, snapshot.attemptId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error("An immutable run snapshot is already frozen for this attempt");
      return existing;
    }
    this.#database.prepare(`
      INSERT INTO run_snapshots(run_id, attempt_id, digest, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.runId, snapshot.attemptId, snapshot.digest, JSON.stringify(snapshot), snapshot.createdAt);
    return this.getRunSnapshot(snapshot.runId, snapshot.attemptId) as RunSnapshot;
  }

  getRunSnapshot(runId: string, attemptId: string): RunSnapshot | undefined {
    const row = this.#database.prepare(
      "SELECT snapshot_json FROM run_snapshots WHERE run_id = ? AND attempt_id = ?",
    ).get(runId, attemptId) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as RunSnapshot : undefined;
  }

  createProviderConnection(record: ProviderConnectionRecord): ProviderConnectionRecord {
    this.#database.prepare(`
      INSERT INTO provider_connections(
        internal_id, id, app_id, tenant_id, user_id, provider_id, display_name, auth_kind,
        credential_profile_id, base_url, model_ids_json, status, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `pc_${randomUUID().replaceAll("-", "")}`,
      record.id, record.appId, record.tenantId, record.userId, record.providerId, record.displayName,
      record.authKind, record.credentialProfileId, record.baseUrl ?? null, JSON.stringify(record.modelIds),
      record.status, record.lastErrorCode ?? null, record.createdAt, record.updatedAt,
    );
    return this.getProviderConnection(record.id, record) as ProviderConnectionRecord;
  }

  getProviderConnection(id: string, owner: ResourceOwner): ProviderConnectionRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM provider_connections
      WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?
    `).get(owner.appId, owner.tenantId, owner.userId, id) as ProviderConnectionRow | undefined;
    return row ? toProviderConnection(row) : undefined;
  }

  listProviderConnections(principal: ResourceOwner): ProviderConnectionRecord[] {
    return (this.#database.prepare(`
      SELECT * FROM provider_connections
      WHERE app_id = ? AND tenant_id = ? AND user_id = ?
      ORDER BY created_at, id
    `).all(principal.appId, principal.tenantId, principal.userId) as unknown as ProviderConnectionRow[]).map(toProviderConnection);
  }

  updateProviderConnection(
    id: string,
    owner: ResourceOwner,
    update: { status: ProviderConnectionRecord["status"]; lastErrorCode?: string },
  ): ProviderConnectionRecord | undefined {
    const updatedAt = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE provider_connections
      SET status = ?, last_error_code = ?, updated_at = ?
      WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?
    `).run(
      update.status, update.lastErrorCode ?? null, updatedAt,
      owner.appId, owner.tenantId, owner.userId, id,
    );
    return Number(result.changes) === 1 ? this.getProviderConnection(id, owner) : undefined;
  }

  deleteProviderConnection(id: string, owner: ResourceOwner): boolean {
    const result = this.#database.prepare(`
      DELETE FROM provider_connections
      WHERE app_id = ? AND tenant_id = ? AND user_id = ? AND id = ?
    `).run(owner.appId, owner.tenantId, owner.userId, id);
    return Number(result.changes) === 1;
  }

  persistRunModelUsage(record: Omit<RunModelUsageRecord, "id">): RunModelUsageRecord {
    const result = this.#database.prepare(`
      INSERT INTO run_model_usage(
        run_id, attempt_id, route_plan_id, model_id, provider_id,
        input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens,
        image_input_tokens, cost_usd, price_snapshot_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runId, record.attemptId, record.routePlanId, record.modelId, record.providerId,
      record.inputTokens, record.outputTokens, record.cachedInputTokens ?? 0, record.cacheWriteInputTokens ?? 0,
      record.imageInputTokens ?? 0, record.costUsd ?? null,
      record.priceSnapshot ? JSON.stringify(record.priceSnapshot) : null, record.recordedAt,
    );
    const row = this.#database.prepare("SELECT * FROM run_model_usage WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as ModelUsageRow;
    return toModelUsage(row);
  }

  listRunModelUsage(runId: string): RunModelUsageRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM run_model_usage WHERE run_id = ? ORDER BY id",
    ).all(runId) as unknown as ModelUsageRow[]).map(toModelUsage);
  }

  recordUsage(runId: string, delta: Partial<RunUsage>): RunRecord {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
      if (!current) throw new Error(`Run not found: ${runId}`);
      if (isTerminalRunStatus(current.status)) {
        throw new Error(`Run ${runId} is terminal; cannot record usage`);
      }
      this.#database.prepare(
        `UPDATE runs SET
          usage_input_tokens = CASE WHEN ? IS NULL THEN usage_input_tokens ELSE usage_input_tokens + ? END,
          usage_input_tokens_reported = CASE WHEN ? IS NULL THEN usage_input_tokens_reported ELSE 1 END,
          usage_output_tokens = CASE WHEN ? IS NULL THEN usage_output_tokens ELSE usage_output_tokens + ? END,
          usage_output_tokens_reported = CASE WHEN ? IS NULL THEN usage_output_tokens_reported ELSE 1 END,
          usage_cost_usd = CASE WHEN ? IS NULL THEN usage_cost_usd ELSE usage_cost_usd + ? END,
          usage_cost_reported = CASE WHEN ? IS NULL THEN usage_cost_reported ELSE 1 END,
          usage_tool_calls = usage_tool_calls + ?, updated_at = ? WHERE id = ?`,
      ).run(
        delta.inputTokens ?? null, delta.inputTokens ?? 0, delta.inputTokens ?? null,
        delta.outputTokens ?? null, delta.outputTokens ?? 0, delta.outputTokens ?? null,
        delta.costUsd ?? null, delta.costUsd ?? 0, delta.costUsd ?? null,
        delta.toolCalls ?? 0, new Date().toISOString(), runId,
      );
      const run = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
      if (!run) throw new Error(`Run not found: ${runId}`);
      this.#database.exec("COMMIT");
      return toRunRecord(run);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordRuntimeContainer(record: RuntimeContainerRecord): void {
    this.#database.prepare(`
      INSERT INTO runtime_containers(
        runtime_container_id, container_name, run_id, attempt_id, workspace_identity,
        tool_call_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runtimeContainerId, record.containerName, record.runId, record.attemptId,
      record.workspaceIdentity, record.toolCallId, record.state, record.createdAt, record.updatedAt,
    );
  }

  updateRuntimeContainerState(runtimeContainerId: string, state: RuntimeContainerState, updatedAt: string): void {
    const result = this.#database.prepare(
      "UPDATE runtime_containers SET state = ?, updated_at = ? WHERE runtime_container_id = ?",
    ).run(state, updatedAt, runtimeContainerId);
    if (Number(result.changes) !== 1) throw new Error(`Runtime container is not recorded: ${runtimeContainerId}`);
  }

  removeRuntimeContainer(runtimeContainerId: string): void {
    this.#database.prepare("DELETE FROM runtime_containers WHERE runtime_container_id = ?").run(runtimeContainerId);
  }

  listRuntimeContainers(): RuntimeContainerRecord[] {
    return (this.#database.prepare(
      "SELECT * FROM runtime_containers ORDER BY created_at, runtime_container_id",
    ).all() as Array<Record<string, unknown>>).map((row) => ({
      runtimeContainerId: String(row.runtime_container_id),
      containerName: String(row.container_name),
      runId: String(row.run_id),
      attemptId: String(row.attempt_id),
      workspaceIdentity: String(row.workspace_identity),
      toolCallId: String(row.tool_call_id),
      state: row.state as RuntimeContainerState,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  readiness(): { ok: boolean; reason?: string } {
    try {
      const quick = this.#database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
      const foreignKeys = this.#database.prepare("PRAGMA foreign_key_check").all();
      if (quick.length !== 1 || quick[0]?.quick_check !== "ok" || foreignKeys.length !== 0) {
        return { ok: false, reason: "integrity-check-failed" };
      }
      this.#database.exec("BEGIN IMMEDIATE");
      this.#database.exec("ROLLBACK");
      return { ok: true };
    } catch {
      try { this.#database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      return { ok: false, reason: "database-unavailable" };
    }
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
        ...(request.providerConnectionId ? { providerConnectionId: request.providerConnectionId } : {}),
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
