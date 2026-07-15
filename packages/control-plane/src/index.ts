import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type {
  CreateRunResponse,
  ApprovalRecord,
  AgentProfileRecord,
  WorkspaceRecord,
  RunAttemptRecord,
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
  readonly #queueTails = new Map<string, Promise<void>>();
  readonly #scheduled = new Set<string>();
  readonly #executions = new Map<string, Promise<void>>();
  #accepting = true;

  constructor(
    private readonly store: RunStore,
    private readonly agent: AgentRunner,
    private readonly options: {
      workspaceLeaseTtlMs?: number;
      workspaceQueueTimeoutMs?: number;
      approvalTimeoutMs?: number;
      maxSubagentDepth?: number;
      requiresApproval?: (tool: ToolCall, run: RunRecord) => boolean;
    } = {},
  ) {
    this.#events.setMaxListeners(0);
  }

  createRun(request: InternalStartRunRequest): CreateRunResponse {
    if (!this.#accepting) throw new Error("Run service is shutting down");
    const result = this.store.createOrGetRun(createId("run"), request);
    if (result.created) {
      this.#notify(result.run.id);
      this.#scheduled.add(result.run.id);
      setImmediate(() => {
        this.#scheduled.delete(result.run.id);
        if (!this.#accepting) return;
        this.#enqueue(result.run);
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

  listChildRuns(parentRunId: string): RunRecord[] {
    return this.store.listChildRuns(parentRunId);
  }

  createChildRun(request: {
    parentRunId: string;
    agent: string;
    input: string;
    idempotencyKey: string;
    budget?: Partial<RunRecord["budget"]>;
  }): CreateRunResponse {
    const parent = this.getRun(request.parentRunId);
    if (!parent || isTerminalRunStatus(parent.status)) throw new Error("Parent run is unavailable or terminal");
    if (parent.depth >= (this.options.maxSubagentDepth ?? 3)) throw new Error("Subagent nesting limit reached");
    const existing = this.store.listChildRuns(parent.id);
    const idempotencyKey = `subagent:${parent.id}:${request.idempotencyKey}`;
    const replay = existing.find((child) => child.idempotencyKey === idempotencyKey);
    if (replay) {
      if (replay.agentId !== request.agent || replay.input !== request.input ||
          Object.entries(request.budget ?? {}).some(([key, value]) => replay.budget[key as keyof RunRecord["budget"]] !== value)) {
        throw new Error("Subagent idempotency key was reused with a different request");
      }
      return { runId: replay.id, status: replay.status, eventCursor: replay.lastSequence, idempotentReplay: true };
    }
    const available = remainingChildBudget(parent, existing);
    const budget = boundedChildBudget(request.budget ?? {}, parent, available);
    const suffix = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24);
    const workspace = `wsp_sub_${suffix}`;
    const session = `ses_sub_${suffix}`;
    const result = this.createRun({
      agent: request.agent,
      workspace,
      session,
      input: request.input,
      budget,
      idempotencyKey,
      parentRunId: parent.id,
      depth: parent.depth + 1,
      deliveryAllowed: false,
      principal: {
        appId: parent.appId, tenantId: parent.tenantId, userId: parent.userId,
        scopes: ["runs:create", "subagents:execute"],
      },
    });
    if (!result.idempotentReplay) {
      this.store.appendEvent({
        runId: parent.id, type: "subagent.started",
        payload: { childRunId: result.runId, agent: request.agent, workspaceId: workspace, depth: parent.depth + 1 },
      });
      this.#notify(parent.id);
    }
    return result;
  }

  async waitForChildRun(parentRunId: string, childRunId: string, timeoutMs = 300_000): Promise<RunRecord> {
    const child = this.getRun(childRunId);
    if (!child || child.parentRunId !== parentRunId) throw new Error("Child run does not belong to the parent");
    return await this.waitForTerminal(childRunId, timeoutMs);
  }

  createAgentProfile(record: AgentProfileRecord): AgentProfileRecord {
    return this.store.createAgentProfile(record);
  }

  getAgentProfile(agentId: string, owner: { appId: string; tenantId: string; userId: string }): AgentProfileRecord | undefined {
    return this.store.getAgentProfile(agentId, owner);
  }

  listAgentProfiles(principal: { appId: string; tenantId: string; userId: string }): AgentProfileRecord[] {
    return this.store.listAgentProfiles(principal);
  }

  createWorkspace(record: WorkspaceRecord): WorkspaceRecord {
    return this.store.createWorkspace(record);
  }

  getWorkspace(workspaceId: string, owner: { appId: string; tenantId: string; userId: string }): WorkspaceRecord | undefined {
    return this.store.getWorkspace(workspaceId, owner);
  }

  listWorkspaces(principal: { appId: string; tenantId: string; userId: string }): WorkspaceRecord[] {
    return this.store.listWorkspaces(principal);
  }

  getSession(sessionId: string, owner: { appId: string; tenantId: string; userId: string }): SessionRecord | undefined {
    return this.store.getSession(sessionId, owner);
  }

  listSessionMessages(sessionId: string, owner: { appId: string; tenantId: string; userId: string }): SessionMessageRecord[] {
    return this.store.listSessionMessages(sessionId, owner);
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
      this.store.completeRunningAttempts(run.id, "ORPHANED");
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

  listRunAttempts(runId: string): RunAttemptRecord[] {
    return this.store.listRunAttempts(runId);
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
    for (const child of this.store.listChildRuns(runId)) this.cancelRun(child.id);
    const controller = this.#active.get(runId);
    if (controller) {
      controller.abort(new RunCancelledError());
    } else {
      this.#transition(runId, "CANCELLED", "run.cancelled", { reason: "requested" });
    }
    return this.getRun(runId);
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (!this.#accepting && this.#executions.size === 0) return;
    this.#accepting = false;
    const pendingRunIds = new Set([
      ...this.#scheduled,
      ...this.#executions.keys(),
      ...this.#active.keys(),
    ]);
    for (const runId of pendingRunIds) this.cancelRun(runId);
    for (const [approvalId, waiter] of this.#approvalWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
      this.#approvalWaiters.delete(approvalId);
    }
    const executions = [...this.#executions.values()];
    if (executions.length === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(executions),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Run service did not drain within ${timeoutMs}ms`)),
            timeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #enqueue(run: RunRecord): void {
    if (!this.#transitionIfActive(run.id, "QUEUED", "run.queued")) return;
    const owner = ownerQueuePrefix(run);
    const keys = [
      `${owner}:workspace:${run.workspaceId}`,
      ...(run.sessionId ? [`${owner}:session:${run.sessionId}`] : []),
    ].sort();
    const predecessors = keys.map((key) => this.#queueTails.get(key) ?? Promise.resolve());
    const remainingMs = acceptedDeadline(run) - Date.now();
    if (remainingMs <= 0) {
      this.#timeoutQueuedRun(run.id, run.budget.totalTimeoutMs);
      return;
    }
    const queueTimeout = setTimeout(
      () => this.#timeoutQueuedRun(run.id, run.budget.totalTimeoutMs),
      remainingMs,
    );
    queueTimeout.unref?.();
    const execution = Promise.allSettled(predecessors).then(async () => {
      clearTimeout(queueTimeout);
      const current = this.getRun(run.id);
      if (!current || isTerminalRunStatus(current.status)) return;
      await this.#execute(run.id);
    });
    const tail = execution.catch(() => undefined);
    this.#executions.set(run.id, tail);
    for (const key of keys) this.#queueTails.set(key, tail);
    void tail.finally(() => {
      this.#executions.delete(run.id);
      for (const key of keys) if (this.#queueTails.get(key) === tail) this.#queueTails.delete(key);
    });
  }

  async #execute(runId: string): Promise<void> {
    const controller = new AbortController();
    this.#active.set(runId, controller);
    let lease: WorkspaceLease | undefined;
    let attempt: RunAttemptRecord | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let terminal: { status: RunStatus; type: RunEventType; payload?: Record<string, unknown> } | undefined;
    try {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run disappeared: ${runId}`);
      const remainingMs = acceptedDeadline(run) - Date.now();
      if (remainingMs <= 0) {
        this.#timeoutQueuedRun(run.id, run.budget.totalTimeoutMs);
        return;
      }
      attempt = this.store.createRunAttempt(runId, createId("att"));
      if (!this.#transitionIfActive(runId, "PREPARING", "run.preparing")) return;

      timeout = setTimeout(
        () => controller.abort(new RunTimeoutError(run.budget.totalTimeoutMs)),
        remainingMs,
      );
      timeout.unref?.();

      lease = await this.#waitForWorkspaceLease(run, controller.signal);
      this.store.appendEvent({
        runId,
        type: "workspace.lease.acquired",
        payload: { workspaceId: run.workspaceId, fencingToken: lease.fencingToken },
      });
      this.#notify(runId);
      if (!this.#transitionIfActive(runId, "RUNNING", "run.started")) return;
      const leaseTtlMs = this.options.workspaceLeaseTtlMs ?? 60_000;
      renewal = setInterval(() => {
        if (!lease || controller.signal.aborted) return;
        const renewed = this.store.renewWorkspaceLease(lease, leaseTtlMs);
        if (!renewed) {
          controller.abort(new WorkspaceLeaseLostError());
          return;
        }
        lease = renewed;
      }, Math.max(10, Math.floor(leaseTtlMs / 3)));
      renewal.unref?.();

      const history = run.sessionId
        ? this.store.listSessionMessages(run.sessionId, run).map(toModelMessage)
        : undefined;
      const profile = this.store.getAgentProfile(run.agentId, run);
      if (!profile) throw new Error(`Agent profile is unavailable: ${run.agentId}`);

      await this.agent.run({
        input: run.input,
        instructions: profile.instructions,
        allowedTools: profile.allowedTools,
        workspaceId: run.workspaceId,
        runId: run.id,
        principal: { appId: run.appId, tenantId: run.tenantId, userId: run.userId, scopes: [] },
        ...(history?.length ? { history } : {}),
        signal: controller.signal,
        maxTurns: run.budget.maxTurns,
        modelIdleTimeoutMs: run.budget.modelIdleTimeoutMs,
        commandTimeoutMs: run.budget.commandTimeoutMs,
        takeSteering: () => this.#takeSteering(runId),
        beforeToolCall: async (call) => {
          if (!lease || !this.store.validateWorkspaceLease(lease)) throw new WorkspaceLeaseLostError();
          await this.#authorizeTool(run, call, controller.signal);
        },
        onEvent: (event) => this.#appendAgentEvent(run, event),
      });

      terminal = { status: "SUCCEEDED", type: "run.succeeded" };
    } catch (error) {
      const reason = controller.signal.reason;
      if (reason instanceof RunCancelledError) {
        terminal = {
          status: "CANCELLED", type: "run.cancelled",
          payload: { reason: "requested" },
        };
      } else if (reason instanceof RunTimeoutError) {
        terminal = {
          status: "TIMED_OUT", type: "run.timed_out",
          payload: {
            code: "run_timeout",
            message: reason.message,
            retryable: true,
          },
        };
      } else if (reason instanceof BudgetExceededError) {
        terminal = {
          status: "FAILED", type: "run.failed",
          payload: {
            code: "budget_exceeded",
            message: reason.message,
            retryable: false,
          },
        };
      } else if (reason instanceof WorkspaceLeaseLostError || error instanceof WorkspaceLeaseLostError) {
        terminal = {
          status: "ORPHANED", type: "run.orphaned",
          payload: {
            code: "workspace_lease_lost",
            message: "Workspace lease renewal or fencing validation failed",
            retryable: true,
          },
        };
      } else {
        terminal = {
          status: "FAILED", type: "run.failed",
          payload: {
            code: "agent_run_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (renewal) clearInterval(renewal);
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
      } else if (lease && terminal?.status === "SUCCEEDED") {
        terminal = {
          status: "ORPHANED", type: "run.orphaned",
          payload: {
            code: "workspace_lease_lost",
            message: "Workspace lease could not be released with the active fencing token",
            retryable: true,
          },
        };
      }
      this.#active.delete(runId);
      this.#steering.delete(runId);
      const latest = this.getRun(runId);
      if (terminal && latest && !isTerminalRunStatus(latest.status)) {
        this.#transition(runId, terminal.status, terminal.type, terminal.payload);
      } else if (attempt && latest && !isTerminalRunStatus(latest.status)) {
        this.#transition(runId, "FAILED", "run.failed", {
          code: "run_finalization_failed",
          message: "Run execution ended without a terminal result",
        });
      }
    }
  }

  #timeoutQueuedRun(runId: string, timeoutMs: number): void {
    const run = this.getRun(runId);
    if (!run || run.status !== "QUEUED") return;
    this.#transition(runId, "TIMED_OUT", "run.timed_out", {
      code: "run_timeout",
      message: new RunTimeoutError(timeoutMs).message,
      retryable: true,
      phase: "queue",
    });
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

  async #authorizeTool(run: RunRecord, call: ToolCall, signal: AbortSignal): Promise<void> {
    const profile = this.store.getAgentProfile(run.agentId, run);
    if (!profile || !profile.allowedTools.includes(call.name)) {
      throw new Error(`Tool is not allowed by agent policy: ${call.name}`);
    }
    if (!run.deliveryAllowed && ["message_send", "integration_reply", "connector_send"].includes(call.name)) {
      throw new Error("Delivery tools are disabled for subagent runs");
    }
    await this.#approveToolIfRequired(run, call, signal);
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
    const usage = event.type === "usage.updated"
      ? {
          inputTokens: numberValue(event.payload.inputTokens),
          outputTokens: numberValue(event.payload.outputTokens),
          costUsd: numberValue(event.payload.costUsd),
        }
      : event.type === "tool.call.requested"
        ? { toolCalls: 1 }
        : undefined;
    this.store.appendEvent({
      runId: run.id,
      type: event.type,
      payload: event.payload,
      ...(usage ? { usage } : {}),
    });
    if (event.type === "usage.updated") {
      this.#enforceBudget(this.getRun(run.id) as RunRecord);
    } else if (event.type === "tool.call.requested") {
      this.#enforceBudget(this.getRun(run.id) as RunRecord);
    }
    if (run.sessionId && event.type === "agent.message.completed") {
      this.store.appendSessionMessage({
        id: createId("msg"),
        sessionId: run.sessionId,
        runId: run.id,
        role: "assistant",
        content: String(event.payload.content ?? ""),
        metadata: { turn: event.payload.turn ?? 0, toolCalls: event.payload.toolCalls ?? [] },
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

  #enforceBudget(run: RunRecord): void {
    const exceeded =
      run.usage.inputTokens > run.budget.maxInputTokens ? "input token" :
      run.usage.outputTokens > run.budget.maxOutputTokens ? "output token" :
      run.usage.costUsd > run.budget.maxCostUsd ? "cost" :
      run.usage.toolCalls > run.budget.maxToolCalls ? "tool call" : undefined;
    if (exceeded) this.#active.get(run.id)?.abort(new BudgetExceededError(exceeded));
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
      ...(typeof payload.code === "string" ? { errorCode: payload.code } : {}),
      ...(typeof payload.message === "string" ? { errorMessage: payload.message } : {}),
    });
    this.#notify(runId);
    if (isTerminalRunStatus(status) && run.parentRunId) {
      const summary = [...this.store.listEvents(run.id)].reverse().find((event) => event.type === "agent.message.completed")?.payload.content;
      this.store.appendEvent({
        runId: run.parentRunId,
        type: "subagent.completed",
        payload: {
          childRunId: run.id, status,
          ...(typeof summary === "string" ? { summary } : {}),
          ...(typeof payload.code === "string" ? { errorCode: payload.code } : {}),
        },
      });
      this.#notify(run.parentRunId);
    }
  }

  #notify(runId: string): void {
    this.#events.emit(runId);
  }
}

class RunTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Run exceeded its total timeout of ${timeoutMs}ms`);
    this.name = "RunTimeoutError";
  }
}

class RunCancelledError extends Error {
  constructor() {
    super("Run was cancelled");
    this.name = "RunCancelledError";
  }
}

class WorkspaceLeaseLostError extends Error {
  constructor() {
    super("Workspace lease was lost");
    this.name = "WorkspaceLeaseLostError";
  }
}

class BudgetExceededError extends Error {
  constructor(kind: string) {
    super(`Run exceeded its ${kind} budget`);
    this.name = "BudgetExceededError";
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function acceptedDeadline(run: RunRecord): number {
  const acceptedAt = Date.parse(run.createdAt);
  if (!Number.isFinite(acceptedAt)) throw new Error(`Run has an invalid accepted timestamp: ${run.id}`);
  return acceptedAt + run.budget.totalTimeoutMs;
}

function ownerQueuePrefix(run: RunRecord): string {
  return `${run.appId.length}:${run.appId}:${run.tenantId.length}:${run.tenantId}:${run.userId.length}:${run.userId}`;
}

function remainingChildBudget(parent: RunRecord, children: readonly RunRecord[]): RunRecord["budget"] {
  const allocated = children.reduce((sum, child) => ({
    maxTurns: sum.maxTurns + child.budget.maxTurns,
    maxToolCalls: sum.maxToolCalls + child.budget.maxToolCalls,
    maxInputTokens: sum.maxInputTokens + child.budget.maxInputTokens,
    maxOutputTokens: sum.maxOutputTokens + child.budget.maxOutputTokens,
    maxCostUsd: sum.maxCostUsd + child.budget.maxCostUsd,
    totalTimeoutMs: Math.max(sum.totalTimeoutMs, child.budget.totalTimeoutMs),
    modelIdleTimeoutMs: Math.max(sum.modelIdleTimeoutMs, child.budget.modelIdleTimeoutMs),
    commandTimeoutMs: Math.max(sum.commandTimeoutMs, child.budget.commandTimeoutMs),
  }), {
    maxTurns: 0, maxToolCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0,
    totalTimeoutMs: 0, modelIdleTimeoutMs: 0, commandTimeoutMs: 0,
  });
  return {
    maxTurns: Math.max(0, parent.budget.maxTurns - allocated.maxTurns),
    maxToolCalls: Math.max(0, parent.budget.maxToolCalls - allocated.maxToolCalls),
    maxInputTokens: Math.max(0, parent.budget.maxInputTokens - parent.usage.inputTokens - allocated.maxInputTokens),
    maxOutputTokens: Math.max(0, parent.budget.maxOutputTokens - parent.usage.outputTokens - allocated.maxOutputTokens),
    maxCostUsd: Math.max(0, parent.budget.maxCostUsd - parent.usage.costUsd - allocated.maxCostUsd),
    totalTimeoutMs: parent.budget.totalTimeoutMs,
    modelIdleTimeoutMs: parent.budget.modelIdleTimeoutMs,
    commandTimeoutMs: parent.budget.commandTimeoutMs,
  };
}

function boundedChildBudget(
  requested: Partial<RunRecord["budget"]>,
  parent: RunRecord,
  available: RunRecord["budget"],
): RunRecord["budget"] {
  const budget: RunRecord["budget"] = {
    maxTurns: requested.maxTurns ?? Math.min(4, available.maxTurns),
    maxToolCalls: requested.maxToolCalls ?? Math.min(8, available.maxToolCalls),
    maxInputTokens: requested.maxInputTokens ?? Math.min(64_000, available.maxInputTokens),
    maxOutputTokens: requested.maxOutputTokens ?? Math.min(16_000, available.maxOutputTokens),
    maxCostUsd: requested.maxCostUsd ?? Math.min(5, available.maxCostUsd),
    totalTimeoutMs: requested.totalTimeoutMs ?? Math.min(300_000, parent.budget.totalTimeoutMs),
    modelIdleTimeoutMs: requested.modelIdleTimeoutMs ?? parent.budget.modelIdleTimeoutMs,
    commandTimeoutMs: requested.commandTimeoutMs ?? parent.budget.commandTimeoutMs,
  };
  for (const key of ["maxTurns", "maxInputTokens", "maxOutputTokens"] as const) {
    if (budget[key] <= 0 || budget[key] > available[key]) throw new Error(`Child ${key} exceeds the remaining parent budget`);
  }
  for (const key of ["maxToolCalls", "maxCostUsd"] as const) {
    if (budget[key] < 0 || budget[key] > available[key]) throw new Error(`Child ${key} exceeds the remaining parent budget`);
  }
  for (const key of ["totalTimeoutMs", "modelIdleTimeoutMs", "commandTimeoutMs"] as const) {
    if (budget[key] <= 0 || budget[key] > parent.budget[key]) throw new Error(`Child ${key} exceeds the parent budget`);
  }
  return budget;
}

function toModelMessage(message: SessionMessageRecord): ModelMessage {
  const toolCalls = message.role === "assistant"
    ? persistedToolCalls(message.metadata.toolCalls)
    : undefined;
  return {
    role: message.role === "system" ? "user" : message.role,
    content: message.content,
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(message.role === "tool" && typeof message.metadata.callId === "string"
      ? { toolCallId: message.metadata.callId }
      : {}),
  };
}

function persistedToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const call = item as Record<string, unknown>;
    if (typeof call.id !== "string" || typeof call.name !== "string" ||
        !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      return undefined;
    }
    calls.push({ id: call.id, name: call.name, arguments: call.arguments as Record<string, unknown> });
  }
  return calls;
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
