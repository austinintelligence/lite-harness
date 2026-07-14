import { randomUUID } from "node:crypto";
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

export interface AppendRunEvent {
  runId: string;
  type: RunEventType;
  payload?: Record<string, unknown>;
  status?: RunStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface RunStore {
  createOrGetRun(
    id: string,
    request: InternalStartRunRequest,
  ): { run: RunRecord; created: boolean };
  getRun(id: string): RunRecord | undefined;
  appendEvent(params: AppendRunEvent): RunEvent;
  listEvents(runId: string, after?: number, limit?: number): RunEvent[];
  listNonTerminalRuns(): RunRecord[];
  getSession(id: string): SessionRecord | undefined;
  appendSessionMessage(params: {
    id: string;
    sessionId: string;
    runId?: string;
    role: SessionMessageRole;
    content: string;
    metadata?: Record<string, unknown>;
  }): SessionMessageRecord;
  listSessionMessages(sessionId: string, limit?: number): SessionMessageRecord[];
  acquireWorkspaceLease(workspaceId: string, runId: string, ttlMs: number): WorkspaceLease | undefined;
  validateWorkspaceLease(lease: WorkspaceLease): boolean;
  releaseWorkspaceLease(lease: WorkspaceLease): boolean;
  createApproval(record: ApprovalRecord): ApprovalRecord;
  getApproval(id: string): ApprovalRecord | undefined;
  resolveApproval(id: string, status: Exclude<ApprovalStatus, "PENDING">): ApprovalRecord | undefined;
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

export function createId(prefix: "run" | "evt" | "tool" | "ses" | "msg" | "art" | "apr"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
