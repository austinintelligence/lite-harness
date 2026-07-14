import { EventEmitter } from "node:events";
import type {
  CreateRunResponse,
  ApprovalRecord,
  InternalStartRunRequest,
  RunEvent,
  RunEventType,
  RunRecord,
  RunStatus,
  SessionMessageRecord,
  SessionRecord,
  WorkspaceLease,
  ToolCall,
} from "@lite-harness/contracts";
import { isTerminalRunStatus } from "@lite-harness/contracts";
import {
  AgentRunner,
  type AgentRuntimeEvent,
  type ModelMessage,
} from "@lite-harness/agent-runtime";
import { assertRunTransition, createId, type RunStore } from "@lite-harness/domain";

export class RunService {
  readonly #events = new EventEmitter();
  readonly #active = new Map<string, AbortController>();
  readonly #steering = new Map<string, ModelMessage[]>();
  readonly #approvalWaiters = new Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly store: RunStore,
    private readonly agent: AgentRunner,
    private readonly options: {
      workspaceLeaseTtlMs?: number;
      workspaceQueueTimeoutMs?: number;
      approvalTimeoutMs?: number;
      requiresApproval?: (tool: ToolCall, run: RunRecord) => boolean;
    } = {},
  ) {
    this.#events.setMaxListeners(0);
  }

  createRun(request: InternalStartRunRequest): CreateRunResponse {
    const result = this.store.createOrGetRun(createId("run"), request);
    if (result.created) {
      this.#notify(result.run.id);
      setImmediate(() => {
        void this.#execute(result.run.id).catch(() => {
          // #execute persists terminal failures. The detached task must not
          // create an unhandled rejection in the host process.
        });
      });
    }
    return {
      runId: result.run.id,
      status: result.run.status,
      eventCursor: result.run.lastSequence,
      idempotentReplay: !result.created,
    };
  }

  getRun(runId: string): RunRecord | undefined {
    return this.store.getRun(runId);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.store.getSession(sessionId);
  }

  listSessionMessages(sessionId: string): SessionMessageRecord[] {
    return this.store.listSessionMessages(sessionId);
  }

  steerRun(runId: string, instruction: string): RunRecord {
    const run = this.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) throw new Error("Run is not active");
    const queue = this.#steering.get(runId) ?? [];
    queue.push({ role: "user", content: instruction });
    this.#steering.set(runId, queue);
    if (run.sessionId) {
      this.store.appendSessionMessage({
        id: createId("msg"), sessionId: run.sessionId, runId, role: "user", content: instruction,
        metadata: { steering: true },
      });
    }
    this.store.appendEvent({ runId, type: "run.steered", payload: { instruction } });
    this.#notify(runId);
    return this.getRun(runId) as RunRecord;
  }

  getApproval(approvalId: string): ApprovalRecord | undefined {
    return this.store.getApproval(approvalId);
  }

  resolveApproval(approvalId: string, approved: boolean): ApprovalRecord | undefined {
    const existing = this.store.getApproval(approvalId);
    if (!existing || existing.status !== "PENDING") return existing;
    const resolved = this.store.resolveApproval(approvalId, approved ? "APPROVED" : "DENIED");
    if (resolved) {
      this.store.appendEvent({
        runId: resolved.runId,
        type: "approval.resolved",
        payload: { approvalId, status: resolved.status },
      });
      this.#notify(resolved.runId);
    }
    const waiter = this.#approvalWaiters.get(approvalId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#approvalWaiters.delete(approvalId);
      waiter.resolve(approved);
    }
    return resolved;
  }

  reconcileInterruptedRuns(): number {
    const interrupted = this.store.listNonTerminalRuns();
    for (const run of interrupted) {
      this.store.appendEvent({
        runId: run.id,
        type: "run.orphaned",
        status: "ORPHANED",
        errorCode: "manager_restarted",
        errorMessage: "Manager restarted while the run was nonterminal; retry with a new idempotency key.",
        payload: {
          status: "ORPHANED",
          retryable: true,
          previousStatus: run.status,
        },
      });
      this.#notify(run.id);
    }
    return interrupted.length;
  }

  listEvents(runId: string, after = 0): RunEvent[] {
    return this.store.listEvents(runId, after);
  }

  async waitForEvents(runId: string, after: number, waitMs = 1_000): Promise<RunEvent[]> {
    const immediate = this.listEvents(runId, after);
    const run = this.getRun(runId);
    if (immediate.length > 0 || !run || isTerminalRunStatus(run.status) || waitMs <= 0) {
      return immediate;
    }

    await new Promise<void>((resolve) => {
      const onEvent = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#events.removeListener(runId, onEvent);
        resolve();
      }, waitMs);
      this.#events.once(runId, onEvent);
    });
    return this.listEvents(runId, after);
  }

  async waitForTerminal(runId: string, timeoutMs = 10_000): Promise<RunRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = this.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (isTerminalRunStatus(run.status)) {
        return run;
      }
      await this.waitForEvents(runId, run.lastSequence, Math.min(250, deadline - Date.now()));
    }
    throw new Error(`Timed out waiting for run ${runId}`);
  }

  cancelRun(runId: string): RunRecord | undefined {
    const run = this.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) {
      return run;
    }
    this.#active.get(runId)?.abort(new Error("Run cancelled"));
    this.#transition(runId, "CANCELLED", "run.cancelled", { reason: "requested" });
    return this.getRun(runId);
  }

  async #execute(runId: string): Promise<void> {
    const controller = new AbortController();
    this.#active.set(runId, controller);
    let lease: WorkspaceLease | undefined;
    try {
      if (!this.#transitionIfActive(runId, "QUEUED", "run.queued")) return;
      if (!this.#transitionIfActive(runId, "PREPARING", "run.preparing")) return;

      const run = this.getRun(runId);
      if (!run) {
        throw new Error(`Run disappeared: ${runId}`);
      }

      lease = await this.#waitForWorkspaceLease(run, controller.signal);
      this.store.appendEvent({
        runId,
        type: "workspace.lease.acquired",
        payload: { workspaceId: run.workspaceId, fencingToken: lease.fencingToken },
      });
      this.#notify(runId);
      if (!this.#transitionIfActive(runId, "RUNNING", "run.started")) return;

      const history = run.sessionId
        ? this.store.listSessionMessages(run.sessionId).map(toModelMessage)
        : undefined;

      await this.agent.run({
        input: run.input,
        workspaceId: run.workspaceId,
        ...(history?.length ? { history } : {}),
        signal: controller.signal,
        takeSteering: () => this.#takeSteering(runId),
        beforeToolCall: (call) => this.#approveToolIfRequired(run, call, controller.signal),
        onEvent: (event) => this.#appendAgentEvent(run, event),
      });

      const latest = this.getRun(runId);
      if (latest && !isTerminalRunStatus(latest.status)) {
        this.#transition(runId, "SUCCEEDED", "run.succeeded");
      }
    } catch (error) {
      const run = this.getRun(runId);
      if (run && !isTerminalRunStatus(run.status)) {
        this.#transition(runId, "FAILED", "run.failed", {
          code: "agent_run_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (lease && this.store.releaseWorkspaceLease(lease)) {
        const latest = this.getRun(runId);
        if (latest) {
          this.store.appendEvent({
            runId,
            type: "workspace.lease.released",
            payload: { workspaceId: latest.workspaceId, fencingToken: lease.fencingToken },
          });
          this.#notify(runId);
        }
      }
      this.#active.delete(runId);
      this.#steering.delete(runId);
    }
  }

  #takeSteering(runId: string): ModelMessage[] {
    const queued = this.#steering.get(runId) ?? [];
    this.#steering.set(runId, []);
    return queued;
  }

  async #approveToolIfRequired(run: RunRecord, call: ToolCall, signal: AbortSignal): Promise<void> {
    if (!this.options.requiresApproval?.(call, run)) return;
    const id = createId("apr");
    const timeoutMs = this.options.approvalTimeoutMs ?? 60_000;
    const record = this.store.createApproval({
      id,
      runId: run.id,
      toolCallId: call.id,
      toolName: call.name,
      status: "PENDING",
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      createdAt: new Date().toISOString(),
    });
    this.store.appendEvent({
      runId: run.id,
      type: "approval.requested",
      payload: { approvalId: id, toolCallId: call.id, toolName: call.name, expiresAt: record.expiresAt },
    });
    this.#notify(run.id);
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#approvalWaiters.delete(id);
        this.store.resolveApproval(id, "EXPIRED");
        this.store.appendEvent({ runId: run.id, type: "approval.resolved", payload: { approvalId: id, status: "EXPIRED" } });
        this.#notify(run.id);
        resolve(false);
      }, timeoutMs);
      this.#approvalWaiters.set(id, { resolve, timer });
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        this.#approvalWaiters.delete(id);
        resolve(false);
      }, { once: true });
    });
    if (!approved) throw new Error(`Tool approval denied or expired: ${call.name}`);
  }

  async #waitForWorkspaceLease(run: RunRecord, signal: AbortSignal): Promise<WorkspaceLease> {
    const ttlMs = this.options.workspaceLeaseTtlMs ?? 60_000;
    const deadline = Date.now() + (this.options.workspaceQueueTimeoutMs ?? 30_000);
    while (Date.now() <= deadline) {
      signal.throwIfAborted();
      const lease = this.store.acquireWorkspaceLease(run.workspaceId, run.id, ttlMs);
      if (lease) return lease;
      await delay(25, signal);
    }
    throw new Error(`Workspace lease timed out for ${run.workspaceId}`);
  }

  #appendAgentEvent(run: RunRecord, event: AgentRuntimeEvent): void {
    this.store.appendEvent({ runId: run.id, type: event.type, payload: event.payload });
    if (run.sessionId && event.type === "agent.message.completed") {
      this.store.appendSessionMessage({
        id: createId("msg"),
        sessionId: run.sessionId,
        runId: run.id,
        role: "assistant",
        content: String(event.payload.content ?? ""),
        metadata: { turn: event.payload.turn ?? 0 },
      });
    } else if (run.sessionId && event.type === "tool.call.completed") {
      this.store.appendSessionMessage({
        id: createId("msg"),
        sessionId: run.sessionId,
        runId: run.id,
        role: "tool",
        content: String(event.payload.content ?? ""),
        metadata: { callId: event.payload.callId ?? "unknown", ok: event.payload.ok ?? false },
      });
    }
    this.#notify(run.id);
  }

  #transitionIfActive(
    runId: string,
    status: RunStatus,
    type: RunEventType,
    payload: Record<string, unknown> = {},
  ): boolean {
    const run = this.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) return false;
    this.#transition(runId, status, type, payload);
    return true;
  }

  #transition(
    runId: string,
    status: RunStatus,
    type: RunEventType,
    payload: Record<string, unknown> = {},
  ): void {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    assertRunTransition(run.status, status);
    this.store.appendEvent({
      runId,
      type,
      payload: { status, ...payload },
      status,
      ...(status === "FAILED" ? { errorCode: String(payload.code ?? "run_failed") } : {}),
      ...(status === "FAILED" ? { errorMessage: String(payload.message ?? "Run failed") } : {}),
    });
    this.#notify(runId);
  }

  #notify(runId: string): void {
    this.#events.emit(runId);
  }
}

function toModelMessage(message: SessionMessageRecord): ModelMessage {
  return {
    role: message.role === "system" ? "user" : message.role,
    content: message.content,
    ...(message.role === "tool" && typeof message.metadata.callId === "string"
      ? { toolCallId: message.metadata.callId }
      : {}),
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Run aborted"));
      },
      { once: true },
    );
  });
}
