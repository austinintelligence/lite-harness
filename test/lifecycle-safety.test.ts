import { describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import type { RunStatus } from "@lite-harness/contracts";
import { RunService } from "@lite-harness/control-plane";
import type { AppendRunEvent, RunStore } from "@lite-harness/domain";
import type { ModelEvent, ModelGateway, ModelMessage } from "@lite-harness/provider-core";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

describe("run lifecycle safety", () => {
  it("BD-002-REGRESSION renews leases and rejects stale fencing epochs at mutation boundaries", async () => {
    const store = new SqliteRunStore(":memory:");
    let renewals = 0;
    let rejectMutation = false;
    const wrapped = runStoreProxy(store, {
      renewWorkspaceLease: (...args) => {
        renewals += 1;
        return store.renewWorkspaceLease(...args);
      },
      validateWorkspaceLease: (lease) => !rejectMutation && store.validateWorkspaceLease(lease),
    });
    const runtime = new InMemoryToolRuntime();
    const slow: ModelGateway = {
      async *streamTurn(params: { messages: readonly ModelMessage[]; signal?: AbortSignal }): AsyncIterable<ModelEvent> {
        if (params.messages.some((message) => message.role === "user" && message.content === "renewed")) {
          await abortableDelay(70, params.signal);
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield {
          type: "tool.call",
          call: { id: "fenced-call", name: "write_file", arguments: { path: "hello.txt", content: "unsafe" } },
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
    };
    const service = new RunService(wrapped, new AgentRunner(slow, runtime), { workspaceLeaseTtlMs: 30 });
    try {
      const renewed = service.createRun(request("renewed", "renewed-workspace"));
      expect((await service.waitForTerminal(renewed.runId)).status).toBe("SUCCEEDED");
      expect(renewals).toBeGreaterThanOrEqual(2);

      rejectMutation = true;
      const fenced = service.createRun(request("fenced", "fenced-workspace"));
      const terminal = await service.waitForTerminal(fenced.runId);
      expect(terminal).toMatchObject({ status: "ORPHANED", errorCode: "workspace_lease_lost" });
      expect(runtime.readFile("fenced-workspace", "hello.txt", principal)).toBeUndefined();
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  it("BD-004-REGRESSION publishes terminal state only after lease cleanup and attempt finalization", async () => {
    const store = new SqliteRunStore(":memory:");
    let released = false;
    const terminalStatuses = new Set<RunStatus>(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"]);
    const wrapped = runStoreProxy(store, {
      releaseWorkspaceLease: (lease) => {
        released = store.releaseWorkspaceLease(lease);
        return released;
      },
      appendEvent: (event: AppendRunEvent) => {
        if (event.status && terminalStatuses.has(event.status)) expect(released).toBe(true);
        return store.appendEvent(event);
      },
    });
    const service = new RunService(wrapped, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()));
    try {
      const created = service.createRun(request("finality", "finality-workspace"));
      const terminal = await service.waitForTerminal(created.runId);
      expect(terminal.status).toBe("SUCCEEDED");
      expect(service.listEvents(created.runId).slice(-2).map((event) => event.type))
        .toEqual(["workspace.lease.released", "run.succeeded"]);
      expect(service.listRunAttempts(created.runId)).toMatchObject([
        { status: "SUCCEEDED", endedAt: expect.any(String) },
      ]);
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  it("BD-005-REGRESSION stops admission, cancels active work, and drains before storage closes", async () => {
    const idle: ModelGateway = {
      async *streamTurn(params: { messages: readonly ModelMessage[]; signal?: AbortSignal }): AsyncIterable<ModelEvent> {
        await abortableDelay(5_000, params.signal);
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(idle, new InMemoryToolRuntime()));
    const created = service.createRun(request("shutdown", "shutdown-workspace"));
    await waitForStatus(service, created.runId, "RUNNING");
    await service.shutdown(1_000);
    expect(service.getRun(created.runId)).toMatchObject({ status: "CANCELLED" });
    expect(service.listRunAttempts(created.runId)).toMatchObject([
      { status: "CANCELLED", endedAt: expect.any(String) },
    ]);
    expect(() => service.createRun(request("rejected", "other-workspace"))).toThrow(/shutting down/);
    expect(() => store.close()).not.toThrow();
  });
});

const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] };

function request(idempotencyKey: string, workspace: string) {
  return { agent: "coder", workspace, input: idempotencyKey, idempotencyKey, principal };
}

function runStoreProxy(store: SqliteRunStore, overrides: Partial<RunStore>): RunStore {
  return new Proxy(store as RunStore, {
    get(target, property) {
      const override = overrides[property as keyof RunStore];
      if (override) return override;
      const value = target[property as keyof RunStore];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function waitForStatus(service: RunService, runId: string, status: RunStatus): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (run?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run did not reach ${status}`);
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
