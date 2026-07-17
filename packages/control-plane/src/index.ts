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
  RunSnapshot,
  RunStatus,
  SessionMessageRecord,
  SessionRecord,
  WorkspaceLease,
  ToolCall,
} from "@lite-harness/contracts";
import { isTerminalRunStatus } from "@lite-harness/contracts";
import {
  AgentRunner,
  type AgentPreparedState,
  type AgentRuntimeEvent,
  type ModelMessage,
} from "@lite-harness/agent-runtime";
import { assertRunTransition, createId, type ResourceOwner, type RunStore } from "@lite-harness/domain";

export interface WorkspaceRunLifecycle {
  prepare(run: RunRecord, signal?: AbortSignal): Promise<{ restored: boolean; recoveredFromPrevious: boolean }>;
  checkpoint(run: RunRecord, options?: { makeCold?: boolean; signal?: AbortSignal }): Promise<{ state: "WARM" | "COLD"; skipped: boolean; snapshot?: { sha256: string; plaintextBytes: number } }>;
}

export interface RunSnapshotReleaseResult {
  outcome: "released" | "cleanup-debt-recorded";
}

export interface RunSnapshotConfiguration {
  runtimeProfile: RunSnapshot["runtimeProfile"];
  networkPolicy: RunSnapshot["networkPolicy"];
  plugins?: RunSnapshot["plugins"] | ((runId: string) => RunSnapshot["plugins"]);
  credentialProfileIds?: string[];
  releaseRun?: (runId: string) => Promise<RunSnapshotReleaseResult | void> | RunSnapshotReleaseResult | void;
}

/**
 * Kernel-owned observability port. The coordinator reports lifecycle facts
 * through this narrow interface without depending on a concrete sink or
 * telemetry package.
 */
export type RunObservabilityAttributes = Record<string, string | number | boolean | undefined>;

export interface RunTraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  end(attributes?: RunObservabilityAttributes): unknown;
}

export interface RunObservability {
  startTrace(name: string, attributes?: RunObservabilityAttributes, parent?: { traceId: string; spanId: string }): RunTraceSpan;
  counter(name: string, value?: number, attributes?: RunObservabilityAttributes): void;
  observe(name: string, value: number, attributes?: RunObservabilityAttributes): void;
  audit(
    name: string,
    outcome: "accepted" | "rejected" | "completed" | "failed",
    attributes?: RunObservabilityAttributes,
    context?: { traceId: string; spanId: string },
  ): void;
}

export class RunService {
  readonly #events = new EventEmitter();
  readonly #active = new Map<string, AbortController>();
  readonly #steering = new Map<string, ModelMessage[]>();
  readonly #approvalWaiters = new Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #queueTails = new Map<string, Promise<void>>();
  readonly #scheduled = new Set<string>();
  readonly #executions = new Map<string, Promise<void>>();
  readonly #executionStartedAt = new Map<string, number>();
  readonly #firstModelToken = new Set<string>();
  readonly #firstVisibleAgentEvent = new Set<string>();
  #accepting = true;

  constructor(
    private readonly store: RunStore,
    private readonly agent: AgentRunner,
    private readonly options: {
      workspaceLeaseTtlMs?: number;
      workspaceLeaseRenewalIntervalMs?: number;
      workspaceQueueTimeoutMs?: number;
      approvalTimeoutMs?: number;
      approvalRouteGeneration?: string | ((run: RunRecord) => string);
      maxSubagentDepth?: number;
      requiresApproval?: (tool: ToolCall, run: RunRecord) => boolean;
      workspaceLifecycle?: WorkspaceRunLifecycle;
      workspaceCheckpointTimeoutMs?: number;
      makeWorkspaceColdAfterCheckpoint?: boolean | ((run: RunRecord) => boolean);
      runSnapshot?: RunSnapshotConfiguration;
      observability?: RunObservability;
    } = {},
  ) {
    this.#events.setMaxListeners(0);
    const leaseTtlMs = this.options.workspaceLeaseTtlMs ?? 60_000;
    const renewalIntervalMs = this.options.workspaceLeaseRenewalIntervalMs ?? Math.max(10, Math.floor(leaseTtlMs / 3));
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 20) throw new Error("Workspace lease TTL must be an integer of at least 20ms");
    if (!Number.isSafeInteger(renewalIntervalMs) || renewalIntervalMs < 1 || renewalIntervalMs >= leaseTtlMs) {
      throw new Error("Workspace lease renewal interval must be a positive integer smaller than the lease TTL");
    }
  }

  createRun(request: InternalStartRunRequest): CreateRunResponse {
    if (!this.#accepting) throw new Error("Run service is shutting down");
    const result = this.store.createOrGetRun(createId("run"), request);
    if (result.created) {
      this.#safeAudit("run.accepted", "accepted", {
        runId: result.run.id, workspaceId: result.run.workspaceId,
        appId: result.run.appId, tenantId: result.run.tenantId, status: result.run.status,
      });
      this.#safeCounter("runs.accepted.total");
      this.#notify(result.run.id);
      this.#scheduled.add(result.run.id);
      setImmediate(() => {
        this.#scheduled.delete(result.run.id);
        if (!this.#accepting) return;
        this.#enqueue(result.run);
      });
    } else {
      this.#safeAudit("run.replayed", "completed", {
        runId: result.run.id, workspaceId: result.run.workspaceId,
        appId: result.run.appId, tenantId: result.run.tenantId, status: result.run.status,
      });
      this.#safeCounter("runs.idempotent_replays.total");
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

  listRuns(principal: ResourceOwner, limit = 100): RunRecord[] {
    return this.store.listRuns(principal, limit);
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

  deleteAgentProfile(agentId: string, owner: { appId: string; tenantId: string; userId: string }): boolean {
    return this.store.deleteAgentProfile(agentId, owner);
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
    const bindingValid = this.#approvalBindingIsCurrent(existing);
    const expired = Date.parse(existing.expiresAt) <= Date.now();
    const status = expired ? "EXPIRED" : bindingValid && approved ? "APPROVED" : "DENIED";
    let resolved = this.store.resolveApprovalAndAppendEvent(
      approvalId,
      status,
      existing.executionDigest,
      { approvalId, status, executionDigest: existing.executionDigest },
    );
    if (status === "APPROVED" && resolved?.status === "PENDING") {
      resolved = this.store.resolveApprovalAndAppendEvent(
        approvalId,
        "EXPIRED",
        existing.executionDigest,
        { approvalId, status: "EXPIRED", executionDigest: existing.executionDigest },
      );
    }
    if (resolved && resolved.status !== "PENDING") {
      this.#notify(resolved.runId);
    }
    const waiter = this.#approvalWaiters.get(approvalId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#approvalWaiters.delete(approvalId);
      waiter.resolve(resolved?.status === "APPROVED");
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
    return boundedEventBatch(this.store.listEvents(runId, after, EVENT_PAGE_LIMIT));
  }

  listRunAttempts(runId: string): RunAttemptRecord[] {
    return this.store.listRunAttempts(runId);
  }

  getWorkspaceLease(runId: string, workspaceId: string): WorkspaceLease | undefined {
    return this.store.getWorkspaceLease(workspaceId, runId);
  }

  validateWorkspaceLease(lease: WorkspaceLease): boolean {
    return this.store.validateWorkspaceLease(lease);
  }

  async waitForEvents(runId: string, after: number, waitMs = 1_000, signal?: AbortSignal): Promise<RunEvent[]> {
    signal?.throwIfAborted();
    const immediate = this.listEvents(runId, after);
    const run = this.getRun(runId);
    if (immediate.length > 0 || !run || isTerminalRunStatus(run.status) || waitMs <= 0) {
      return immediate;
    }

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.#events.removeListener(runId, onEvent);
        signal?.removeEventListener("abort", onAbort);
      };
      const onEvent = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Event wait aborted"));
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, waitMs);
      this.#events.once(runId, onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    signal?.throwIfAborted();
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
    let executionTrace: RunTraceSpan | undefined;
    this.#active.set(runId, controller);
    let lease: WorkspaceLease | undefined;
    let attempt: RunAttemptRecord | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let workspacePrepared = false;
    let terminal: { status: RunStatus; type: RunEventType; payload?: Record<string, unknown> } | undefined;
    try {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run disappeared: ${runId}`);
      const lifecycleAttributes = {
        runId: run.id, workspaceId: run.workspaceId,
        appId: run.appId, tenantId: run.tenantId,
      };
      this.#executionStartedAt.set(run.id, Date.now());
      executionTrace = this.#safeStartTrace("run.execute", lifecycleAttributes);
      this.#safeObserve("run.queue_wait_ms", Math.max(0, Date.now() - Date.parse(run.createdAt)), lifecycleAttributes);
      this.#safeCounter("runs.attempts.started", 1, lifecycleAttributes);
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
      this.#safeCounter("workspace.leases.acquired", 1, lifecycleAttributes);
      this.#safeAudit("workspace.lease", "accepted", lifecycleAttributes, executionTrace);
      this.#notify(runId);
      if (this.options.workspaceLifecycle) {
        const prepared = await this.options.workspaceLifecycle.prepare(run, controller.signal);
        workspacePrepared = true;
        if (prepared.restored) {
          this.store.appendEvent({
            runId, type: "workspace.restore.completed",
            payload: { workspaceId: run.workspaceId, recoveredFromPrevious: prepared.recoveredFromPrevious },
          });
          this.#notify(runId);
        }
      }
      if (!this.#transitionIfActive(runId, "RUNNING", "run.started")) return;
      const leaseTtlMs = this.options.workspaceLeaseTtlMs ?? 60_000;
      const renewalIntervalMs = this.options.workspaceLeaseRenewalIntervalMs ?? Math.max(10, Math.floor(leaseTtlMs / 3));
      renewal = setInterval(() => {
        if (!lease || controller.signal.aborted) return;
        const renewed = this.store.renewWorkspaceLease(lease, leaseTtlMs);
        if (!renewed) {
          controller.abort(new WorkspaceLeaseLostError());
          return;
        }
        lease = renewed;
      }, renewalIntervalMs);
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
        attemptId: attempt.id,
        fencingToken: lease.fencingToken,
        maxCostUsd: run.budget.maxCostUsd,
        modelCapabilities: profile.modelCapabilities,
        principal: { appId: run.appId, tenantId: run.tenantId, userId: run.userId, scopes: [] },
        ...(history?.length ? { history } : {}),
        signal: controller.signal,
        maxTurns: run.budget.maxTurns,
        modelIdleTimeoutMs: run.budget.modelIdleTimeoutMs,
        commandTimeoutMs: run.budget.commandTimeoutMs,
        takeSteering: () => this.#takeSteering(runId),
        beforeToolCall: async (call) => {
          if (!lease || !this.store.validateWorkspaceLease(lease)) throw new WorkspaceLeaseLostError();
          return await this.#authorizeTool(run, call, controller.signal);
        },
        onPrepared: async (prepared) => {
          if (!this.options.runSnapshot || !attempt) return;
          this.#freezeRunSnapshot(run, attempt, profile, prepared);
        },
        onEvent: (event) => this.#appendAgentEvent(run, event, attempt?.id),
      });

      if (this.options.workspaceLifecycle) this.#transition(runId, "CHECKPOINTING", "run.checkpointing");
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
      if (workspacePrepared && lease && this.options.workspaceLifecycle && terminal) {
        const checkpointController = new AbortController();
        const checkpointTimeoutMs = this.options.workspaceCheckpointTimeoutMs ?? 300_000;
        const checkpointTimeout = setTimeout(
          () => checkpointController.abort(new Error(`Workspace checkpoint exceeded ${checkpointTimeoutMs}ms`)),
          checkpointTimeoutMs,
        );
        checkpointTimeout.unref?.();
        try {
          const currentRun = this.getRun(runId);
          if (currentRun) {
            if (!lease || !this.store.validateWorkspaceLease(lease)) throw new WorkspaceLeaseLostError();
            const configured = this.options.makeWorkspaceColdAfterCheckpoint;
            const makeCold = typeof configured === "function" ? configured(currentRun) : configured ?? false;
            const checkpoint = await this.options.workspaceLifecycle.checkpoint(currentRun, { makeCold, signal: checkpointController.signal });
            this.store.appendEvent({
              runId, type: "workspace.checkpoint.completed",
              payload: {
                workspaceId: currentRun.workspaceId, state: checkpoint.state, skipped: checkpoint.skipped,
                ...(checkpoint.snapshot ? { sha256: checkpoint.snapshot.sha256, plaintextBytes: checkpoint.snapshot.plaintextBytes } : {}),
              },
            });
            this.#notify(runId);
          }
        } catch (error) {
          this.store.appendEvent({
            runId, type: "workspace.checkpoint.failed",
            payload: { workspaceId: this.getRun(runId)?.workspaceId, message: error instanceof Error ? error.message : String(error) },
          });
          this.#notify(runId);
          if (error instanceof WorkspaceLeaseLostError) terminal = {
            status: "ORPHANED", type: "run.orphaned",
            payload: { code: "workspace_lease_lost", message: error.message, retryable: true },
          };
          else if (terminal.status === "SUCCEEDED") terminal = {
            status: "FAILED", type: "run.failed",
            payload: { code: "workspace_checkpoint_failed", message: error instanceof Error ? error.message : String(error) },
          };
        } finally { clearTimeout(checkpointTimeout); }
      }
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
      this.#executionStartedAt.delete(runId);
      this.#firstModelToken.delete(runId);
      this.#firstVisibleAgentEvent.delete(runId);
      try {
        const release = await this.options.runSnapshot?.releaseRun?.(runId);
        if (release?.outcome === "cleanup-debt-recorded") {
          terminal = {
            status: "ORPHANED",
            type: "run.orphaned",
            payload: {
              code: "run_cleanup_failed",
              message: "Required run cleanup exhausted its retry budget; durable cleanup debt was recorded",
              retryable: true,
            },
          };
        }
      } catch {
        terminal = {
          status: "ORPHANED",
          type: "run.orphaned",
          payload: {
            code: "run_finalization_failed",
            message: "Required run finalization failed before cleanup completion or durable recovery state could be confirmed",
            retryable: true,
          },
        };
      }
      const latest = this.getRun(runId);
      if (terminal && latest && !isTerminalRunStatus(latest.status)) {
        this.#transition(runId, terminal.status, terminal.type, terminal.payload);
      } else if (attempt && latest && !isTerminalRunStatus(latest.status)) {
        this.#transition(runId, "FAILED", "run.failed", {
          code: "run_finalization_failed",
          message: "Run execution ended without a terminal result",
        });
      }
      const finalRun = this.getRun(runId);
      const finalStatus = finalRun?.status ?? terminal?.status ?? "FAILED";
      const terminalAttributes = {
        ...(finalRun ? {
          runId: finalRun.id, workspaceId: finalRun.workspaceId,
          appId: finalRun.appId, tenantId: finalRun.tenantId,
        } : { runId }),
        status: finalStatus,
      };
      this.#safeCounter("runs.terminal.total", 1, terminalAttributes);
      this.#safeCounter(`runs.${finalStatus.toLowerCase()}.total`, 1, terminalAttributes);
      this.#safeAudit("run.terminal", finalStatus === "SUCCEEDED" ? "completed" : "failed", terminalAttributes, executionTrace);
      try { executionTrace?.end({ status: finalStatus }); } catch { /* telemetry must not affect finalization */ }
    }
  }

  #safeStartTrace(name: string, attributes: RunObservabilityAttributes = {}): RunTraceSpan | undefined {
    try { return this.options.observability?.startTrace(name, attributes); } catch { return undefined; }
  }

  #safeCounter(name: string, value = 1, attributes: RunObservabilityAttributes = {}): void {
    try { this.options.observability?.counter(name, value, attributes); } catch { /* telemetry must not affect runs */ }
  }

  #safeObserve(name: string, value: number, attributes: RunObservabilityAttributes = {}): void {
    try { this.options.observability?.observe(name, value, attributes); } catch { /* telemetry must not affect runs */ }
  }

  #safeAudit(
    name: string,
    outcome: "accepted" | "rejected" | "completed" | "failed",
    attributes: RunObservabilityAttributes = {},
    context?: RunTraceSpan,
  ): void {
    try { this.options.observability?.audit(name, outcome, attributes, context); } catch { /* telemetry must not affect runs */ }
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

  #freezeRunSnapshot(run: RunRecord, attempt: RunAttemptRecord, profile: AgentProfileRecord, prepared: AgentPreparedState): void {
    const providerRoute = this.store.getRunRoutePlan(run.id, attempt.id);
    if (!providerRoute || !prepared.route || providerRoute.routePlanId !== prepared.route.routePlanId) {
      throw new Error("Provider route was not durably frozen before the first model turn");
    }
    const configuration = this.options.runSnapshot as RunSnapshotConfiguration;
    const createdAt = new Date().toISOString();
    const content = {
      schemaVersion: 1 as const, runId: run.id, attemptId: attempt.id,
      agent: structuredClone(profile),
      tools: prepared.tools.map((tool) => structuredClone(tool)).sort((left, right) => left.name.localeCompare(right.name)),
      skills: prepared.contextSnapshot.skills.map((skill) => ({ ...skill })).sort((left, right) => left.name.localeCompare(right.name)),
      plugins: (typeof configuration.plugins === "function" ? configuration.plugins(run.id) : configuration.plugins ?? [])
        .map((plugin) => ({ ...plugin }))
        .sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)),
      providerRoute: structuredClone(providerRoute), runtimeProfile: structuredClone(configuration.runtimeProfile),
      networkPolicy: structuredClone(configuration.networkPolicy), budget: structuredClone(run.budget),
      credentialProfileIds: [...new Set([providerRoute.selectedCredentialProfileId, ...(configuration.credentialProfileIds ?? [])])].sort(),
      createdAt,
    };
    const snapshot: RunSnapshot = { ...content, digest: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
    this.store.persistRunSnapshot(snapshot);
    this.store.appendEvent({ runId: run.id, type: "run.snapshot.frozen", payload: { attemptId: attempt.id, digest: snapshot.digest } });
    this.#notify(run.id);
  }

  async #approveToolIfRequired(
    run: RunRecord,
    call: ToolCall,
    policyGeneration: number,
    signal: AbortSignal,
  ): Promise<ApprovalRecord | undefined> {
    if (!this.options.requiresApproval?.(call, run)) return undefined;
    signal.throwIfAborted();
    const id = createId("apr");
    const timeoutMs = this.options.approvalTimeoutMs ?? 60_000;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    const routeGeneration = this.#approvalRouteGeneration(run);
    const argumentsDigest = approvalArgumentsDigest(call.arguments);
    const executionDigest = approvalExecutionDigest({
      runId: run.id,
      toolCallId: call.id,
      toolName: call.name,
      toolArgumentsDigest: argumentsDigest,
      appId: run.appId,
      tenantId: run.tenantId,
      userId: run.userId,
      workspaceId: run.workspaceId,
      policyGeneration,
      routeGeneration,
      expiresAt,
    });
    const record = this.store.createApproval({
      id,
      runId: run.id,
      toolCallId: call.id,
      toolName: call.name,
      toolArgumentsDigest: argumentsDigest,
      executionDigest,
      appId: run.appId,
      tenantId: run.tenantId,
      userId: run.userId,
      workspaceId: run.workspaceId,
      policyGeneration,
      routeGeneration,
      status: "PENDING",
      expiresAt,
      createdAt,
    });
    this.store.appendEvent({
      runId: run.id,
      type: "approval.requested",
      payload: {
        approvalId: id,
        toolCallId: call.id,
        toolName: call.name,
        toolArgumentsDigest: record.toolArgumentsDigest,
        executionDigest: record.executionDigest,
        expiresAt: record.expiresAt,
      },
    });
    this.#notify(run.id);
    const approved = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#approvalWaiters.delete(id);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const recordResolution = (status: "DENIED" | "EXPIRED") => {
        const resolved = this.store.resolveApprovalAndAppendEvent(
          id,
          status,
          record.executionDigest,
          { approvalId: id, status, executionDigest: record.executionDigest },
        );
        if (resolved?.status !== status) return;
        this.#notify(run.id);
      };
      const onAbort = () => {
        recordResolution("DENIED");
        settle(false);
      };
      const timer = setTimeout(() => {
        recordResolution("EXPIRED");
        settle(false);
      }, timeoutMs);
      this.#approvalWaiters.set(id, { resolve: settle, timer });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    if (!approved) throw new Error(`Tool approval denied or expired: ${call.name}`);
    return record;
  }

  async #authorizeTool(run: RunRecord, call: ToolCall, signal: AbortSignal): Promise<(() => void) | undefined> {
    const profile = this.store.getAgentProfile(run.agentId, run);
    if (!profile || !profile.allowedTools.includes(call.name)) {
      throw new Error(`Tool is not allowed by agent policy: ${call.name}`);
    }
    if (!run.deliveryAllowed && ["message_send", "integration_reply", "connector_send"].includes(call.name)) {
      throw new Error("Delivery tools are disabled for subagent runs");
    }
    const approval = await this.#approveToolIfRequired(run, call, profile.version, signal);
    return approval ? () => this.#assertApprovalExecutable(approval.id, run, call) : undefined;
  }

  #approvalBindingIsCurrent(record: ApprovalRecord, call?: ToolCall): boolean {
    const run = this.store.getRun(record.runId);
    if (!run) return false;
    const profile = this.store.getAgentProfile(run.agentId, run);
    if (!profile) return false;
    const routeGeneration = this.#approvalRouteGeneration(run);
    if (record.appId !== run.appId || record.tenantId !== run.tenantId || record.userId !== run.userId ||
        record.workspaceId !== run.workspaceId || record.policyGeneration !== profile.version ||
        record.routeGeneration !== routeGeneration) {
      return false;
    }
    const argumentsDigest = call ? approvalArgumentsDigest(call.arguments) : record.toolArgumentsDigest;
    const digest = approvalExecutionDigest({
      runId: run.id,
      toolCallId: call?.id ?? record.toolCallId,
      toolName: call?.name ?? record.toolName,
      toolArgumentsDigest: argumentsDigest,
      appId: run.appId,
      tenantId: run.tenantId,
      userId: run.userId,
      workspaceId: run.workspaceId,
      policyGeneration: profile.version,
      routeGeneration,
      expiresAt: record.expiresAt,
    });
    return digest === record.executionDigest;
  }

  #assertApprovalExecutable(approvalId: string, run: RunRecord, call: ToolCall): void {
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.status !== "APPROVED") throw new Error("Tool approval is not approved");
    if (Date.parse(approval.expiresAt) <= Date.now()) throw new Error("Tool approval expired before execution");
    if (approval.runId !== run.id || !this.#approvalBindingIsCurrent(approval, call)) {
      throw new Error("Tool approval execution binding changed before execution");
    }
  }

  #approvalRouteGeneration(run: RunRecord): string {
    const configured = this.options.approvalRouteGeneration;
    const generation = typeof configured === "function"
      ? configured(run)
      : configured ?? "default-route-v1";
    if (!generation || generation.length > 256 || /[\r\n\0]/.test(generation)) {
      throw new Error("Approval route generation must be a bounded single-line value");
    }
    return generation;
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

  #appendAgentEvent(run: RunRecord, event: AgentRuntimeEvent, attemptId?: string): void {
    const current = this.getRun(run.id);
    if (!current || isTerminalRunStatus(current.status)) return;
    const usage = event.type === "usage.updated"
      ? {
          inputTokens: numberValue(event.payload.inputTokens),
          outputTokens: numberValue(event.payload.outputTokens),
          costUsd: numberValue(event.payload.costUsd),
        }
      : event.type === "tool.call.requested"
        ? { toolCalls: 1 }
        : undefined;
    const telemetryAttributes: RunObservabilityAttributes = {
      runId: run.id, workspaceId: run.workspaceId,
      appId: run.appId, tenantId: run.tenantId,
      ...(attemptId ? { attemptId } : {}),
    };
    const elapsedMs = this.#executionStartedAt.get(run.id);
    if (event.type === "agent.message.delta" && elapsedMs !== undefined) {
      const elapsed = Math.max(0, Date.now() - elapsedMs);
      if (!this.#firstModelToken.has(run.id)) {
        this.#firstModelToken.add(run.id);
        this.#safeObserve("run.time_to_first_model_token_ms", elapsed, telemetryAttributes);
      }
      if (!this.#firstVisibleAgentEvent.has(run.id)) {
        this.#firstVisibleAgentEvent.add(run.id);
        this.#safeObserve("run.time_to_first_visible_event_ms", elapsed, telemetryAttributes);
      }
    }
    if (event.type === "usage.updated") {
      const inputTokens = numberValue(event.payload.inputTokens);
      const outputTokens = numberValue(event.payload.outputTokens);
      if (Number.isSafeInteger(inputTokens)) this.#safeCounter("model.input_tokens.total", inputTokens, telemetryAttributes);
      if (Number.isSafeInteger(outputTokens)) this.#safeCounter("model.output_tokens.total", outputTokens, telemetryAttributes);
      if (typeof event.payload.costUsd === "number" && Number.isFinite(event.payload.costUsd) && event.payload.costUsd >= 0) {
        this.#safeObserve("model.cost_usd", event.payload.costUsd, telemetryAttributes);
      }
    }
    try {
      this.store.appendEvent({
        runId: run.id,
        type: event.type,
        payload: event.payload,
        ...(usage ? { usage } : {}),
      });
    } catch (error) {
      if (isTerminalRunStatus(this.getRun(run.id)?.status ?? run.status)) return;
      throw error;
    }
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
      try {
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
      } catch (error) {
        // A parent may have become terminal while a non-cooperative child was
        // draining. Terminal parent state is final; dropping this summary is
        // safer than reopening or mutating the parent run.
        const parent = this.getRun(run.parentRunId);
        if (!parent || !isTerminalRunStatus(parent.status)) throw error;
      }
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

export interface ApprovalExecutionBinding {
  runId: string;
  toolCallId: string;
  toolName: string;
  toolArgumentsDigest: string;
  appId: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
  policyGeneration: number;
  routeGeneration: string;
  expiresAt: string;
}

/** Hashes JSON tool arguments without depending on object insertion order. */
export function approvalArgumentsDigest(argumentsValue: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalApprovalJson(argumentsValue)).digest("hex");
}

/** Immutable authorization identity rechecked at resolution and immediately before execution. */
export function approvalExecutionDigest(binding: ApprovalExecutionBinding): string {
  return createHash("sha256").update(canonicalApprovalJson({
    version: 1,
    ...binding,
  })).digest("hex");
}

function canonicalApprovalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Approval arguments must contain only finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalApprovalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new Error("Approval arguments must not contain undefined values");
      return `${JSON.stringify(key)}:${canonicalApprovalJson(record[key])}`;
    }).join(",")}}`;
  }
  throw new Error("Approval arguments must contain only JSON values");
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

export const EVENT_PAGE_LIMIT = 256;
export const EVENT_PAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Keeps each cursor page well below the bounded local IPC response ceiling. */
export function boundedEventBatch(
  events: readonly RunEvent[],
  maxBytes = EVENT_PAGE_MAX_BYTES,
): RunEvent[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Event page byte limit is invalid");
  const page: RunEvent[] = [];
  let bytes = Buffer.byteLength('{"events":[]}');
  for (const event of events.slice(0, EVENT_PAGE_LIMIT)) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event)) + (page.length ? 1 : 0);
    if (eventBytes > maxBytes) throw new Error(`Run event ${event.sequence} exceeds the IPC event page limit`);
    if (bytes + eventBytes > maxBytes) {
      if (page.length === 0) throw new Error(`Run event ${event.sequence} exceeds the IPC event page envelope limit`);
      break;
    }
    page.push(event);
    bytes += eventBytes;
  }
  return page;
}
