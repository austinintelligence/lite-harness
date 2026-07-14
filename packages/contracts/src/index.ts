import { Type, type Static } from "@sinclair/typebox";

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

export const CreateRunRequestSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1, maxLength: 128 }),
    workspace: Type.String({ minLength: 1, maxLength: 128 }),
    session: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    input: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  },
  { additionalProperties: false },
);

export type CreateRunRequest = Static<typeof CreateRunRequestSchema>;

export interface InternalPrincipal {
  appId: string;
  tenantId: string;
  userId: string;
  scopes: string[];
}

export interface InternalStartRunRequest extends CreateRunRequest {
  idempotencyKey: string;
  principal: InternalPrincipal;
}

export interface RunRecord {
  id: string;
  idempotencyKey: string;
  appId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  sessionId?: string;
  input: string;
  status: RunStatus;
  lastSequence: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface PublishArtifactRequest {
  path: string;
  mediaType: string;
  dataBase64: string;
}

export interface InternalPublishArtifactRequest extends PublishArtifactRequest {
  principal: InternalPrincipal;
}

export interface ArtifactPayloadResponse {
  record: ArtifactRecord;
  dataBase64: string;
}

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

export interface ApprovalRecord {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
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
  | "run.steered"
  | "agent.message.delta"
  | "agent.message.completed"
  | "tool.call.requested"
  | "tool.call.completed"
  | "usage.updated"
  | "workspace.lease.acquired"
  | "workspace.lease.released"
  | "approval.requested"
  | "approval.resolved"
  | "artifact.created"
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
