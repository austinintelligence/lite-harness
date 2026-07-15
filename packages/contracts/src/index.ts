import { Type, type Static } from "@sinclair/typebox";

/** Public REST contract generation. Increment only for a breaking wire change. */
export const LITE_API_VERSION = "v1" as const;

/** Local Gateway-to-Manager wire protocol generation. */
export const LITE_IPC_PROTOCOL_VERSION = "1" as const;
export const LITE_IPC_VERSION_HEADER = "x-lite-ipc-version" as const;

export const ErrorDetailSchema = Type.Record(Type.String(), Type.Unknown());
export const StructuredErrorSchema = Type.Object({
  version: Type.Literal(1),
  code: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 4_096 }),
  retryable: Type.Boolean(),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
  details: Type.Optional(ErrorDetailSchema),
}, { additionalProperties: false });

export const ErrorEnvelopeSchema = Type.Object({
  error: StructuredErrorSchema,
}, { additionalProperties: false });

export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export function errorEnvelope(
  code: string,
  message: string,
  options: { retryable?: boolean; retryAfterMs?: number; details?: Record<string, unknown> } = {},
): ErrorEnvelope {
  return {
    error: {
      version: 1,
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
}

export interface ManagerHealth {
  ok: boolean;
  role: "manager";
  protocolVersion: typeof LITE_IPC_PROTOCOL_VERSION;
  instanceId: string;
  uptimeSeconds: number;
  rssBytes: number;
}

export interface ReadinessDependency {
  ok: boolean;
  reason?: string;
}

export interface ManagerReadiness {
  ok: boolean;
  role: "manager";
  protocolVersion: typeof LITE_IPC_PROTOCOL_VERSION;
  dependencies: Record<string, ReadinessDependency>;
}

export const RunStatusSchema = Type.Union([
  Type.Literal("ACCEPTED"),
  Type.Literal("QUEUED"),
  Type.Literal("PREPARING"),
  Type.Literal("RUNNING"),
  Type.Literal("CHECKPOINTING"),
  Type.Literal("SUCCEEDED"),
  Type.Literal("FAILED"),
  Type.Literal("CANCELLED"),
  Type.Literal("TIMED_OUT"),
  Type.Literal("ORPHANED"),
]);

export type RunStatus = Static<typeof RunStatusSchema>;

export const RunBudgetOverridesSchema = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  totalTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 86_400_000 })),
  modelIdleTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000 })),
  commandTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000 })),
}, { additionalProperties: false });
export type RunBudgetOverrides = Static<typeof RunBudgetOverridesSchema>;

export const CreateRunRequestSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1, maxLength: 128 }),
    workspace: Type.String({ minLength: 1, maxLength: 128 }),
    session: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    input: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    budget: Type.Optional(RunBudgetOverridesSchema),
  },
  { additionalProperties: false },
);

export type CreateRunRequest = Static<typeof CreateRunRequestSchema>;

export const InternalPrincipalSchema = Type.Object({
  appId: Type.String({ minLength: 1, maxLength: 128 }),
  tenantId: Type.String({ minLength: 1, maxLength: 128 }),
  userId: Type.String({ minLength: 1, maxLength: 128 }),
  scopes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256, uniqueItems: true }),
  tokenId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  tokenType: Type.Optional(Type.Union([Type.Literal("app"), Type.Literal("run")])),
  replayPolicy: Type.Optional(Type.Union([Type.Literal("multi_use"), Type.Literal("resource_bound_multi_use")])),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  budgetCeiling: Type.Optional(RunBudgetOverridesSchema),
}, { additionalProperties: false });

export type InternalPrincipal = Static<typeof InternalPrincipalSchema>;

export const MintRunTokenRequestSchema = Type.Object({
  scopes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 64, uniqueItems: true }),
  ttlSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 3_600 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  budgetCeiling: Type.Optional(RunBudgetOverridesSchema),
}, { additionalProperties: false });

export type MintRunTokenRequest = Static<typeof MintRunTokenRequestSchema>;

export const MintRunTokenResponseSchema = Type.Object({
  token: Type.String({ minLength: 16, maxLength: 4_096 }),
  tokenId: Type.String({ minLength: 1, maxLength: 128 }),
  expiresAt: Type.String({ format: "date-time" }),
  scopes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 64, uniqueItems: true }),
  replayPolicy: Type.Literal("resource_bound_multi_use"),
}, { additionalProperties: false });

export type MintRunTokenResponse = Static<typeof MintRunTokenResponseSchema>;

export const RevokeTokenResponseSchema = Type.Object({
  tokenId: Type.String({ minLength: 1, maxLength: 128 }),
  revoked: Type.Literal(true),
}, { additionalProperties: false });

export type RevokeTokenResponse = Static<typeof RevokeTokenResponseSchema>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const InternalStartRunRequestSchema = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 128 }),
  workspace: Type.String({ minLength: 1, maxLength: 128 }),
  session: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  input: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  budget: Type.Optional(RunBudgetOverridesSchema),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
  principal: InternalPrincipalSchema,
  parentRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })),
  deliveryAllowed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type InternalStartRunRequest = Static<typeof InternalStartRunRequestSchema>;

export interface RunRecord {
  id: string;
  idempotencyKey: string;
  appId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  sessionId?: string;
  parentRunId?: string;
  depth: number;
  deliveryAllowed: boolean;
  input: string;
  budget: RunBudget;
  usage: RunUsage;
  status: RunStatus;
  lastSequence: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeContainerState = "CREATED" | "RUNNING" | "STOPPING";

/** Durable Manager record for a Docker object owned by one tool execution. */
export interface RuntimeContainerRecord {
  runtimeContainerId: string;
  containerName: string;
  runId: string;
  attemptId: string;
  workspaceIdentity: string;
  toolCallId: string;
  state: RuntimeContainerState;
  createdAt: string;
  updatedAt: string;
}

export interface RunBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  totalTimeoutMs: number;
  modelIdleTimeoutMs: number;
  commandTimeoutMs: number;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: number;
}

export interface RunRoutePlanRecord {
  runId: string;
  attemptId: string;
  routePlanId: string;
  registryGeneration: number;
  requiredCapabilities: AgentModelCapability[];
  selectedModelId: string;
  selectedProviderId: string;
  selectedCredentialProfileId: string;
  fallbackModelIds: string[];
  createdAt: string;
}

export interface RunModelUsageRecord {
  id: number;
  runId: string;
  attemptId: string;
  routePlanId: string;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  imageInputTokens?: number;
  costUsd?: number;
  priceSnapshot?: {
    currency: "USD";
    source: string;
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    cachedInputUsdPerMillion?: number;
    cacheWriteInputUsdPerMillion?: number;
    imageInputUsdPerMillion?: number;
    longContextThresholdTokens?: number;
    longContextInputMultiplier?: number;
    longContextOutputMultiplier?: number;
  };
  recordedAt: string;
}

export interface RunSnapshot {
  schemaVersion: 1;
  runId: string;
  attemptId: string;
  agent: AgentProfileRecord;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  skills: Array<{ name: string; digest: string }>;
  plugins: Array<{ id: string; version: string; digest: string }>;
  providerRoute: RunRoutePlanRecord;
  runtimeProfile: { id: string; imageDigest?: string; policyDigest: string };
  networkPolicy: { id: string; digest: string };
  budget: RunBudget;
  credentialProfileIds: string[];
  createdAt: string;
  digest: string;
}

export type AgentModelCapability = "text" | "tools" | "vision" | "json" | "reasoning" | "delegated-agent";
export const AgentModelCapabilitySchema = Type.Union([
  Type.Literal("text"), Type.Literal("tools"), Type.Literal("vision"),
  Type.Literal("json"), Type.Literal("reasoning"), Type.Literal("delegated-agent"),
]);

export interface AgentProfileRecord {
  id: string;
  version: number;
  appId: string;
  tenantId: string;
  userId: string;
  name: string;
  instructions: string;
  modelCapabilities: AgentModelCapability[];
  allowedTools: string[];
  defaultBudget: RunBudget;
  createdAt: string;
}

export interface CreateAgentProfileRequest {
  id?: string;
  name: string;
  instructions?: string;
  modelCapabilities?: AgentModelCapability[];
  allowedTools?: string[];
  defaultBudget?: Partial<RunBudget>;
}

export const CreateAgentProfileRequestSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  name: Type.String({ minLength: 1, maxLength: 128, pattern: ".*\\S.*" }),
  instructions: Type.Optional(Type.String({ maxLength: 1_000_000 })),
  modelCapabilities: Type.Optional(Type.Array(AgentModelCapabilitySchema, { maxItems: 6, uniqueItems: true })),
  allowedTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1_000 })),
  defaultBudget: Type.Optional(RunBudgetOverridesSchema),
}, { additionalProperties: false });

export const InternalCreateAgentProfileRequestSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  name: Type.String({ minLength: 1, maxLength: 128, pattern: ".*\\S.*" }),
  instructions: Type.Optional(Type.String({ maxLength: 1_000_000 })),
  modelCapabilities: Type.Optional(Type.Array(AgentModelCapabilitySchema, { maxItems: 6, uniqueItems: true })),
  allowedTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1_000 })),
  defaultBudget: Type.Optional(RunBudgetOverridesSchema),
  principal: InternalPrincipalSchema,
}, { additionalProperties: false });

export type InternalCreateAgentProfileRequest = Static<typeof InternalCreateAgentProfileRequestSchema>;

export interface WorkspaceRecord {
  id: string;
  appId: string;
  tenantId: string;
  userId: string;
  mode: "managed" | "registered-bind";
  state: "WARM" | "COLD" | "RESTORING" | "IN_USE" | "SNAPSHOTTING" | "CORRUPT" | "ERROR";
  registeredPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceRequest {
  id?: string;
  mode?: "managed";
}

export const CreateWorkspaceRequestSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  mode: Type.Optional(Type.Literal("managed")),
}, { additionalProperties: false });

export const InternalCreateWorkspaceRequestSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  mode: Type.Optional(Type.Literal("managed")),
  principal: InternalPrincipalSchema,
}, { additionalProperties: false });

export type InternalCreateWorkspaceRequest = Static<typeof InternalCreateWorkspaceRequestSchema>;

export interface RunAttemptRecord {
  id: string;
  runId: string;
  attempt: number;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "ORPHANED";
  startedAt: string;
  endedAt?: string;
}

export const DEFAULT_RUN_BUDGET: RunBudget = Object.freeze({
  maxTurns: 8,
  maxToolCalls: 32,
  maxInputTokens: 250_000,
  maxOutputTokens: 64_000,
  maxCostUsd: 25,
  totalTimeoutMs: 15 * 60_000,
  modelIdleTimeoutMs: 2 * 60_000,
  commandTimeoutMs: 5 * 60_000,
});

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export interface SessionRecord {
  id: string;
  appId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessageRecord {
  id: string;
  sessionId: string;
  runId?: string;
  role: SessionMessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WorkspaceLease {
  workspaceId: string;
  ownerRunId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  appId: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export const PublishArtifactRequestSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4_096 }),
  mediaType: Type.String({ minLength: 3, maxLength: 255, pattern: "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$" }),
}, { additionalProperties: false });

export type PublishArtifactRequest = Static<typeof PublishArtifactRequestSchema>;

export const InternalPublishArtifactRequestSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4_096 }),
  mediaType: Type.String({ minLength: 3, maxLength: 255, pattern: "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$" }),
  principal: InternalPrincipalSchema,
}, { additionalProperties: false });

export type InternalPublishArtifactRequest = Static<typeof InternalPublishArtifactRequestSchema>;

export interface ArtifactPayloadResponse {
  record: ArtifactRecord;
  dataBase64: string;
}

export type StructuredError = Static<typeof StructuredErrorSchema>;

export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

export interface ApprovalRecord {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolArgumentsDigest: string;
  executionDigest: string;
  appId: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
  policyGeneration: number;
  routeGeneration: string;
  status: ApprovalStatus;
  expiresAt: string;
  createdAt: string;
  resolvedAt?: string;
}

export type RunEventType =
  | "run.accepted"
  | "run.queued"
  | "run.preparing"
  | "run.started"
  | "run.snapshot.frozen"
  | "run.checkpointing"
  | "run.timed_out"
  | "run.steered"
  | "agent.message.delta"
  | "agent.message.completed"
  | "tool.call.requested"
  | "tool.call.completed"
  | "usage.updated"
  | "workspace.lease.acquired"
  | "workspace.lease.released"
  | "workspace.restore.started"
  | "workspace.restore.completed"
  | "workspace.checkpoint.completed"
  | "workspace.checkpoint.failed"
  | "approval.requested"
  | "approval.resolved"
  | "artifact.created"
  | "subagent.started"
  | "subagent.completed"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "run.orphaned";

export interface RunEvent<TPayload = Record<string, unknown>> {
  runId: string;
  sequence: number;
  type: RunEventType;
  payload: TPayload;
  createdAt: string;
}

export interface CreateRunResponse {
  runId: string;
  status: RunStatus;
  eventCursor: number;
  idempotentReplay: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

const terminalStatuses = new Set<RunStatus>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "ORPHANED",
]);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalStatuses.has(status);
}
