import { describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway, type ModelEvent, type ModelGateway, type ModelMessage } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] };

describe("run budgets and timeouts", () => {
  it("persists usage and stops before a tool executes when its token budget is exceeded", async () => {
    const store = new SqliteRunStore(":memory:");
    const runtime = new InMemoryToolRuntime();
    const service = new RunService(store, new AgentRunner(new FakeModelGateway(), runtime));
    try {
      const created = service.createRun({
        agent: "coder", workspace: "budget-workspace", input: "write", idempotencyKey: "budget", principal,
        budget: { maxInputTokens: 1 },
      });
      const terminal = await service.waitForTerminal(created.runId);
      expect(terminal).toMatchObject({ status: "FAILED", errorCode: "budget_exceeded" });
      expect(terminal.usage.inputTokens).toBeGreaterThan(1);
      expect(runtime.readFile("budget-workspace", "hello.txt")).toBeUndefined();
    } finally { store.close(); }
  });

  it("aborts an idle provider at the total run timeout and records a timed-out attempt", async () => {
    const idle: ModelGateway = {
      async *streamTurn(params: { messages: readonly ModelMessage[]; signal?: AbortSignal }): AsyncIterable<ModelEvent> {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          params.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(params.signal?.reason instanceof Error ? params.signal.reason : new Error("aborted"));
          }, { once: true });
        });
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(idle, new InMemoryToolRuntime()));
    try {
      const created = service.createRun({
        agent: "coder", workspace: "timeout-workspace", input: "wait", idempotencyKey: "timeout", principal,
        budget: { totalTimeoutMs: 100, modelIdleTimeoutMs: 1_000 },
      });
      const terminal = await service.waitForTerminal(created.runId, 2_000);
      expect(terminal).toMatchObject({ status: "TIMED_OUT", errorCode: "run_timeout" });
      expect(service.listRunAttempts(created.runId)).toMatchObject([{ status: "TIMED_OUT" }]);
    } finally { store.close(); }
  });

  it("serializes runs that target the same workspace", async () => {
    let active = 0;
    let peak = 0;
    const delayed: ModelGateway = {
      async *streamTurn(params: { messages: readonly ModelMessage[]; signal?: AbortSignal }): AsyncIterable<ModelEvent> {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 40);
            params.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(params.signal?.reason instanceof Error ? params.signal.reason : new Error("aborted"));
            }, { once: true });
          });
          yield { type: "completed", finishReason: "stop" };
        } finally {
          active -= 1;
        }
      },
    };
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(delayed, new InMemoryToolRuntime()));
    try {
      const first = service.createRun({
        agent: "coder", workspace: "shared", input: "first", idempotencyKey: "queue-1", principal,
      });
      const second = service.createRun({
        agent: "coder", workspace: "shared", input: "second", idempotencyKey: "queue-2", principal,
      });
      const terminal = await Promise.all([
        service.waitForTerminal(first.runId),
        service.waitForTerminal(second.runId),
      ]);
      expect(terminal.map((run) => run.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
      expect(peak).toBe(1);
    } finally { store.close(); }
  });
});
