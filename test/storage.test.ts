import { afterEach, describe, expect, it } from "vitest";
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

  it("persists implicit sessions and rejects cross-owner session reuse", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const created = store.createOrGetRun("run-first", request());
    expect(created.run.sessionId).toBe("ses_first");
    expect(store.getSession("ses_first")).toMatchObject({
      tenantId: "tenant-1",
      userId: "user-1",
      agentId: "coder",
    });
    expect(store.listSessionMessages("ses_first")).toMatchObject([
      { role: "user", content: "Create a file", runId: "run-first" },
    ]);

    expect(() =>
      store.createOrGetRun("run-second", {
        ...request("second"),
        idempotencyKey: "request-2",
        session: "ses_first",
        principal: { ...request().principal, tenantId: "tenant-other" },
      }),
    ).toThrow(/does not belong/);
  });

  it("uses monotonically increasing fencing tokens to reject stale workspace writers", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const first = store.acquireWorkspaceLease("workspace-1", "run-first", 10_000);
    expect(first).toMatchObject({ ownerRunId: "run-first", fencingToken: 1 });
    expect(store.acquireWorkspaceLease("workspace-1", "run-second", 10_000)).toBeUndefined();
    expect(first && store.releaseWorkspaceLease(first)).toBe(true);

    const second = store.acquireWorkspaceLease("workspace-1", "run-second", 10_000);
    expect(second).toMatchObject({ ownerRunId: "run-second", fencingToken: 2 });
    expect(first && store.validateWorkspaceLease(first)).toBe(false);
    expect(second && store.validateWorkspaceLease(second)).toBe(true);
  });
});
