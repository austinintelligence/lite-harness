import { describe, expect, it } from "vitest";
import { AgentRunner } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import type { ModelEvent, ModelGateway, ModelMessage } from "@lite-harness/provider-core";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

describe("accepted-to-terminal deadlines", () => {
  it("BD-012-REGRESSION times out a queued run before its predecessor releases the workspace", async () => {
    let providerCalls = 0;
    const delayed: ModelGateway = {
      async *streamTurn(params: { messages: readonly ModelMessage[]; signal?: AbortSignal }): AsyncIterable<ModelEvent> {
        providerCalls += 1;
        await abortableDelay(200, params.signal);
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(delayed, new InMemoryToolRuntime()));
    try {
      const first = service.createRun(request("first", "queue-first", 1_000));
      const second = service.createRun(request("second", "queue-second", 50));

      const queuedTerminal = await service.waitForTerminal(second.runId, 1_000);
      expect(queuedTerminal).toMatchObject({
        status: "TIMED_OUT",
        errorCode: "run_timeout",
        errorMessage: "Run exceeded its total timeout of 50ms",
      });
      expect(service.listEvents(second.runId).at(-1)).toMatchObject({
        type: "run.timed_out",
        payload: { phase: "queue" },
      });
      expect(service.listRunAttempts(second.runId)).toEqual([]);
      expect(providerCalls).toBe(1);
      expect((await service.waitForTerminal(first.runId, 1_000)).status).toBe("SUCCEEDED");
    } finally {
      store.close();
    }
  });

  it("does not serialize owners that share a public workspace slug", async () => {
    let active = 0;
    let peak = 0;
    const delayed: ModelGateway = {
      async *streamTurn(params: { messages: readonly ModelMessage[]; signal?: AbortSignal }): AsyncIterable<ModelEvent> {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await abortableDelay(40, params.signal);
          yield { type: "completed", finishReason: "stop" };
        } finally {
          active -= 1;
        }
      },
    };
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(delayed, new InMemoryToolRuntime()));
    try {
      const first = service.createRun(request("first", "owner-first", 1_000));
      const second = service.createRun({
        ...request("second", "owner-second", 1_000),
        principal: { appId: "app", tenantId: "tenant", userId: "other-user", scopes: ["runs:create"] },
      });
      expect((await Promise.all([
        service.waitForTerminal(first.runId), service.waitForTerminal(second.runId),
      ])).map((run) => run.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
      expect(peak).toBe(2);
    } finally {
      store.close();
    }
  });
});

function request(input: string, idempotencyKey: string, totalTimeoutMs: number) {
  return {
    agent: "coder",
    workspace: "shared-workspace",
    input,
    idempotencyKey,
    budget: { totalTimeoutMs },
    principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    }, { once: true });
  });
}
