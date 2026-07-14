import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { SqliteMemoryStore } from "@lite-harness/memory-sqlite";
import { BrokeredToolRuntime, InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable subagent runs", () => {
  it("persists isolated children, inherited budgets, and parent completion events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-subagents-")); cleanup.push(directory);
    const path = join(directory, "runs.db");
    let store = new SqliteRunStore(path);
    const service = new RunService(store, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()));
    const parent = service.createRun({
      agent: "coder", workspace: "parent-workspace", input: "parent task", idempotencyKey: "parent",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
    });
    const child = service.createChildRun({
      parentRunId: parent.runId, agent: "coder", input: "child task", idempotencyKey: "tool-call-1",
      budget: { maxTurns: 2, maxToolCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1 },
    });
    const replay = service.createChildRun({
      parentRunId: parent.runId, agent: "coder", input: "child task", idempotencyKey: "tool-call-1",
      budget: { maxTurns: 2, maxToolCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1 },
    });
    expect(replay).toMatchObject({ runId: child.runId, idempotentReplay: true });
    await expect(service.waitForTerminal(parent.runId)).resolves.toMatchObject({ status: "SUCCEEDED" });
    const childRun = await service.waitForTerminal(child.runId);
    expect(childRun).toMatchObject({ parentRunId: parent.runId, depth: 1, deliveryAllowed: false, status: "SUCCEEDED" });
    expect(childRun.workspaceId).not.toBe("parent-workspace");
    expect(service.listEvents(parent.runId).some((event) => event.type === "subagent.completed")).toBe(true);
    store.close();

    store = new SqliteRunStore(path);
    expect(store.listChildRuns(parent.runId)).toMatchObject([{ id: child.runId, parentRunId: parent.runId, depth: 1 }]);
    store.close();
  });

  it("rejects oversubscribed children and cascades cancellation", () => {
    const store = new SqliteRunStore(":memory:");
    try {
      const service = new RunService(store, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()));
      const parent = service.createRun({
        agent: "coder", workspace: "workspace", input: "parent", idempotencyKey: "parent-cancel",
        budget: { maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1, maxTurns: 2, maxToolCalls: 2 },
        principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      });
      expect(() => service.createChildRun({
        parentRunId: parent.runId, agent: "coder", input: "too large", idempotencyKey: "large",
        budget: { maxInputTokens: 2_000 },
      })).toThrow(/remaining parent budget/);
      const child = service.createChildRun({
        parentRunId: parent.runId, agent: "coder", input: "child", idempotencyKey: "small",
        budget: { maxTurns: 1, maxToolCalls: 0, maxInputTokens: 500, maxOutputTokens: 500, maxCostUsd: 0 },
      });
      expect(service.cancelRun(parent.runId)).toMatchObject({ status: "CANCELLED" });
      expect(service.getRun(child.runId)).toMatchObject({ status: "CANCELLED" });
    } finally { store.close(); }
  });
});

describe("live memory and brokered tools", () => {
  it("keeps exact memory durable and handles registered tools on the trusted host", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-memory-live-")); cleanup.push(directory);
    const path = join(directory, "memory.db");
    let memory = new SqliteMemoryStore(path);
    const entry = memory.add("tenant", "workspace", "Deploy the blue canary after the health gate.");
    expect(memory.get("tenant", "workspace", entry.id)).toEqual(entry);
    memory.close();
    memory = new SqliteMemoryStore(path);
    expect(memory.search("tenant", "workspace", "blue health")).toMatchObject([{ id: entry.id }]);
    expect(memory.get("other", "workspace", entry.id)).toBeUndefined();
    expect(memory.remove("tenant", "workspace", entry.id)).toBe(true);
    expect(memory.search("tenant", "workspace", "blue")).toEqual([]);
    memory.close();

    const fallback = { execute: vi.fn(async (params) => ({ callId: params.call.id, ok: true, content: "fallback" })) };
    const broker = new BrokeredToolRuntime(fallback);
    broker.register("memory_search", async (params) => ({ callId: params.call.id, ok: true, content: "brokered" }));
    await expect(broker.execute({ workspaceId: "w", call: { id: "one", name: "memory_search", arguments: {} } }))
      .resolves.toMatchObject({ content: "brokered" });
    await expect(broker.execute({ workspaceId: "w", call: { id: "two", name: "read_file", arguments: {} } }))
      .resolves.toMatchObject({ content: "fallback" });
    expect(fallback.execute).toHaveBeenCalledOnce();
  });
});
