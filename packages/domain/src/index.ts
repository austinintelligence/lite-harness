import { randomUUID } from "node:crypto";
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
  RunRoutePlanRecord,
  RunSnapshot,
  RunStatus,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  ProviderConnectionRecord,
  WorkspaceLease,
} from "@lite-harness/contracts";

export interface AppendRunEvent {
  runId: string;
  type: RunEventType;
  payload?: Record<string, unknown>;
  status?: RunStatus;
  errorCode?: string;
  errorMessage?: string;
  usage?: Partial<RunUsage>;
}

export interface ResourceOwner {
  appId: string;
  tenantId: string;
  userId: string;
}

export interface RunStore {
  createOrGetRun(
    id: string,
    request: InternalStartRunRequest,
  ): { run: RunRecord; created: boolean };
  getRun(id: string): RunRecord | undefined;
  listRuns(principal: ResourceOwner, limit?: number): RunRecord[];
  listChildRuns(parentRunId: string): RunRecord[];
  appendEvent(params: AppendRunEvent): RunEvent;
  listEvents(runId: string, after?: number, limit?: number): RunEvent[];
  listNonTerminalRuns(): RunRecord[];
  getSession(id: string, owner: ResourceOwner): SessionRecord | undefined;
  appendSessionMessage(params: {
    id: string;
    sessionId: string;
    runId: string;
    role: SessionMessageRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): SessionMessageRecord;
  listSessionMessages(sessionId: string, owner: ResourceOwner, limit?: number): SessionMessageRecord[];
  acquireWorkspaceLease(workspaceId: string, runId: string, ttlMs: number): WorkspaceLease | undefined;
  getWorkspaceLease(workspaceId: string, runId: string): WorkspaceLease | undefined;
  renewWorkspaceLease(lease: WorkspaceLease, ttlMs: number): WorkspaceLease | undefined;
  validateWorkspaceLease(lease: WorkspaceLease): boolean;
  releaseWorkspaceLease(lease: WorkspaceLease): boolean;
  createApproval(record: ApprovalRecord): ApprovalRecord;
  getApproval(id: string): ApprovalRecord | undefined;
  resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, "PENDING">,
    expectedExecutionDigest: string,
  ): ApprovalRecord | undefined;
  resolveApprovalAndAppendEvent(
    id: string,
    status: Exclude<ApprovalStatus, "PENDING">,
    expectedExecutionDigest: string,
    payload: Record<string, unknown>,
  ): ApprovalRecord | undefined;
  createAgentProfile(record: AgentProfileRecord): AgentProfileRecord;
  getAgentProfile(id: string, owner: ResourceOwner): AgentProfileRecord | undefined;
  listAgentProfiles(principal: ResourceOwner): AgentProfileRecord[];
  deleteAgentProfile(id: string, owner: ResourceOwner): boolean;
  deleteAgentProfile(id: string, owner: ResourceOwner): boolean;
  createWorkspace(record: WorkspaceRecord): WorkspaceRecord;
  getWorkspace(id: string, owner: ResourceOwner): WorkspaceRecord | undefined;
  listWorkspaces(principal: ResourceOwner): WorkspaceRecord[];
  updateWorkspaceState(id: string, owner: ResourceOwner, expected: WorkspaceRecord["state"], state: WorkspaceRecord["state"]): WorkspaceRecord | undefined;
  createRunAttempt(runId: string, id: string): RunAttemptRecord;
  completeRunAttempt(id: string, status: Exclude<RunAttemptRecord["status"], "RUNNING">): RunAttemptRecord;
  completeRunningAttempts(runId: string, status: Exclude<RunAttemptRecord["status"], "RUNNING">): number;
  listRunAttempts(runId: string): RunAttemptRecord[];
  recordUsage(runId: string, delta: Partial<RunUsage>): RunRecord;
  getRunRoutePlan(runId: string, attemptId: string): RunRoutePlanRecord | undefined;
  persistRunSnapshot(snapshot: RunSnapshot): RunSnapshot;
  getRunSnapshot(runId: string, attemptId: string): RunSnapshot | undefined;
  createProviderConnection(record: ProviderConnectionRecord): ProviderConnectionRecord;
  getProviderConnection(id: string, owner: ResourceOwner): ProviderConnectionRecord | undefined;
  listProviderConnections(principal: ResourceOwner): ProviderConnectionRecord[];
  updateProviderConnection(
    id: string,
    owner: ResourceOwner,
    update: { status: ProviderConnectionRecord["status"]; lastErrorCode?: string },
  ): ProviderConnectionRecord | undefined;
  deleteProviderConnection(id: string, owner: ResourceOwner): boolean;
}

const allowedTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  ACCEPTED: ["QUEUED", "CANCELLED", "FAILED"],
  QUEUED: ["PREPARING", "CANCELLED", "FAILED", "TIMED_OUT"],
  PREPARING: ["RUNNING", "CANCELLED", "FAILED", "TIMED_OUT"],
  RUNNING: ["CHECKPOINTING", "SUCCEEDED", "CANCELLED", "FAILED", "TIMED_OUT", "ORPHANED"],
  CHECKPOINTING: ["SUCCEEDED", "FAILED", "ORPHANED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  ORPHANED: [],
};

export class InvalidRunTransitionError extends Error {
  readonly code = "invalid_run_transition";

  constructor(from: RunStatus, to: RunStatus) {
    super(`Run cannot transition from ${from} to ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new InvalidRunTransitionError(from, to);
  }
}

export function createId(prefix: "run" | "evt" | "tool" | "ses" | "msg" | "art" | "apr" | "agt" | "wsp" | "att"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
