import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RUN_BUDGET } from "@lite-harness/contracts";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const stores: SqliteRunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

function request(input = "Create a file") {
  return {
    agent: "coder",
    workspace: "workspace-1",
    input,
    idempotencyKey: "request-1",
    principal: {
      appId: "app-1",
      tenantId: "tenant-1",
      userId: "user-1",
      scopes: ["runs:create"],
    },
  };
}

describe("SqliteRunStore", () => {
  it("creates a durable accepted event and replays the same idempotent request", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const first = store.createOrGetRun("run-first", request());
    const replay = store.createOrGetRun("run-ignored", request());

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe("run-first");
    expect(store.listEvents("run-first")).toMatchObject([
      { sequence: 1, type: "run.accepted", payload: { status: "ACCEPTED" } },
    ]);
  });

  it("rejects reuse of an idempotency key for a different request", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    store.createOrGetRun("run-first", request());
    expect(() => store.createOrGetRun("run-second", request("Different input"))).toThrow(
      /different run request/,
    );
  });

  it("fails closed when a public-style run request opts out of resource provisioning", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    expect(() => store.createOrGetRun("run-missing-agent", {
      ...request(), idempotencyKey: "missing-agent", createIfMissing: false,
    })).toThrow(/Agent profile is unavailable/);

    store.createAgentProfile({
      id: "coder", version: 1, appId: "app-1", tenantId: "tenant-1", userId: "user-1",
      name: "Coder", instructions: "", modelCapabilities: ["text"], allowedTools: ["read_file"],
      defaultBudget: DEFAULT_RUN_BUDGET, createdAt: new Date().toISOString(),
    });
    expect(() => store.createOrGetRun("run-missing-workspace", {
      ...request(), idempotencyKey: "missing-workspace", createIfMissing: false,
    })).toThrow(/Workspace is unavailable/);
  });

  it("appends ordered events and updates the projected state atomically", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    store.createOrGetRun("run-first", request());
    const event = store.appendEvent({
      runId: "run-first",
      type: "run.queued",
      payload: { status: "QUEUED" },
      status: "QUEUED",
    });

    expect(event.sequence).toBe(2);
    expect(store.getRun("run-first")).toMatchObject({ status: "QUEUED", lastSequence: 2 });
  });

  it("retrieves the durable typed tail after more than ten thousand events", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    store.createOrGetRun("run-long", request());
    for (let index = 0; index < 10_050; index += 1) {
      store.appendEvent({ runId: "run-long", type: "agent.message.delta", payload: { delta: String(index) } });
    }
    store.appendEvent({
      runId: "run-long", type: "agent.message.completed", payload: { content: "durable tail" },
    });

    expect(store.listEvents("run-long", 10_000, 256)).toHaveLength(52);
    expect(store.getLastEvent("run-long")).toMatchObject({ sequence: 10_052, type: "agent.message.completed" });
    expect(store.getLastEvent("run-long", "agent.message.completed")).toMatchObject({
      sequence: 10_052, payload: { content: "durable tail" },
    });
  });

  it("persists implicit sessions and scopes an explicit session slug by owner", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const created = store.createOrGetRun("run-first", request());
    expect(created.run.sessionId).toBe("ses_first");
    expect(store.getSession("ses_first", request().principal)).toMatchObject({
      tenantId: "tenant-1",
      userId: "user-1",
      agentId: "coder",
    });
    expect(store.listSessionMessages("ses_first", request().principal)).toMatchObject([
      { role: "user", content: "Create a file", runId: "run-first" },
    ]);

    const other = { ...request().principal, tenantId: "tenant-other" };
    store.createOrGetRun("run-second", {
      ...request("second"),
      idempotencyKey: "request-2",
      session: "ses_first",
      principal: other,
    });
    expect(store.listSessionMessages("ses_first", other)).toMatchObject([{ content: "second" }]);
    expect(store.listSessionMessages("ses_first", request().principal)).toMatchObject([{ content: "Create a file" }]);
  });

  it("binds a session to its first workspace and rejects cross-project reuse", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    store.createOrGetRun("run-first", {
      ...request(),
      idempotencyKey: "session-first",
      session: "shared-session",
    });

    expect(() => store.createOrGetRun("run-other-workspace", {
      ...request("second project"),
      idempotencyKey: "session-second",
      session: "shared-session",
      workspace: "workspace-2",
    })).toThrow(/bound to a different workspace/);

    expect(store.createOrGetRun("run-same-workspace", {
      ...request("same project"),
      idempotencyKey: "session-third",
      session: "shared-session",
    }).created).toBe(true);
  });

  it("uses monotonically increasing fencing tokens to reject stale workspace writers", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    store.createOrGetRun("run-first", request());
    store.createOrGetRun("run-second", {
      ...request("second"), idempotencyKey: "request-2",
    });
    const first = store.acquireWorkspaceLease("workspace-1", "run-first", 10_000);
    expect(first).toMatchObject({ ownerRunId: "run-first", fencingToken: 1 });
    expect(store.acquireWorkspaceLease("workspace-1", "run-second", 10_000)).toBeUndefined();
    expect(first && store.releaseWorkspaceLease(first)).toBe(true);

    const second = store.acquireWorkspaceLease("workspace-1", "run-second", 10_000);
    expect(second).toMatchObject({ ownerRunId: "run-second", fencingToken: 2 });
    expect(first && store.validateWorkspaceLease(first)).toBe(false);
    expect(second && store.validateWorkspaceLease(second)).toBe(true);
  });

  it("A06-SAME-RUN-EXPIRY-FENCING increments the fencing epoch when the same run reclaims an expired lease", async () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    store.createOrGetRun("run-expiring", request());
    const first = store.acquireWorkspaceLease("workspace-1", "run-expiring", 20);
    expect(first).toMatchObject({ ownerRunId: "run-expiring", fencingToken: 1 });
    await new Promise((resolve) => setTimeout(resolve, 35));
    const second = store.acquireWorkspaceLease("workspace-1", "run-expiring", 10_000);
    expect(second).toMatchObject({ ownerRunId: "run-expiring", fencingToken: 2 });
    expect(first && store.validateWorkspaceLease(first)).toBe(false);
    expect(second && store.validateWorkspaceLease(second)).toBe(true);
  });

  it("persists explicit catalogs, run attempts, budgets, and usage", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const now = new Date().toISOString();
    store.createAgentProfile({
      id: "agent-explicit", version: 1, appId: "app-1", tenantId: "tenant-1", userId: "user-1",
      name: "Explicit", instructions: "Be precise", modelCapabilities: ["text"], allowedTools: ["read_file"],
      defaultBudget: {
        maxTurns: 4, maxToolCalls: 3, maxInputTokens: 100, maxOutputTokens: 100,
        maxCostUsd: 1, totalTimeoutMs: 10_000, modelIdleTimeoutMs: 1_000, commandTimeoutMs: 1_000,
      },
      createdAt: now,
    });
    store.createWorkspace({
      id: "workspace-explicit", appId: "app-1", tenantId: "tenant-1", userId: "user-1",
      mode: "managed", state: "WARM", createdAt: now, updatedAt: now,
    });
    const created = store.createOrGetRun("run-budget", {
      ...request("budgeted"), idempotencyKey: "budgeted", agent: "agent-explicit", workspace: "workspace-explicit",
      budget: { maxTurns: 2 },
    });
    expect(created.run.budget).toMatchObject({ maxTurns: 2, maxToolCalls: 3 });
    expect(created.run.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, toolCalls: 0 });
    const attempt = store.createRunAttempt(created.run.id, "att-1");
    expect(store.completeRunAttempt(attempt.id, "SUCCEEDED")).toMatchObject({ status: "SUCCEEDED", endedAt: expect.any(String) });
    expect(store.recordUsage(created.run.id, { inputTokens: 5, toolCalls: 1 }).usage).toMatchObject({ inputTokens: 5, toolCalls: 1 });
  });
});
