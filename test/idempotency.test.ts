import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const stores: SqliteRunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("user-scoped idempotency", () => {
  it("BD-014-REGRESSION permits the same key for distinct users in one tenant", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);

    const first = store.createOrGetRun("run-user-one", request("user-one", "agent-one", "workspace-one"));
    const second = store.createOrGetRun("run-user-two", request("user-two", "agent-two", "workspace-two"));

    expect(first).toMatchObject({ created: true, run: { id: "run-user-one", idempotencyKey: "shared-key" } });
    expect(second).toMatchObject({ created: true, run: { id: "run-user-two", idempotencyKey: "shared-key" } });
  });

  it("replays semantically identical nested requests regardless of property order", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const base = request("user-one", "agent-one", "workspace-one");

    const first = store.createOrGetRun("run-first", {
      ...base,
      budget: { maxTurns: 4, maxToolCalls: 3 },
    });
    const replay = store.createOrGetRun("run-ignored", {
      ...base,
      budget: { maxToolCalls: 3, maxTurns: 4 },
    });

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, run: { id: "run-first" } });
  });
});

function request(userId: string, agent: string, workspace: string) {
  return {
    agent,
    workspace,
    input: "Create a file",
    idempotencyKey: "shared-key",
    principal: {
      appId: "app-one",
      tenantId: "tenant-one",
      userId,
      scopes: ["runs:create"],
    },
  };
}
