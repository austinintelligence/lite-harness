import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("transactional run projections", () => {
  it("BD-021-REGRESSION rolls back an event when its projection update fails", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-atomic-projection-"));
    roots.push(root);
    const path = join(root, "atomic.db");
    let store = new SqliteRunStore(path);
    store.createOrGetRun("run-atomic", request());
    store.close();

    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER reject_run_projection BEFORE UPDATE ON runs
      BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END;
    `);
    database.close();

    store = new SqliteRunStore(path);
    expect(() => store.appendEvent({
      runId: "run-atomic",
      type: "usage.updated",
      payload: { inputTokens: 7 },
      usage: { inputTokens: 7 },
    })).toThrow(/injected projection failure/);
    expect(store.listEvents("run-atomic")).toHaveLength(1);
    expect(store.getRun("run-atomic")).toMatchObject({ lastSequence: 1, usage: { inputTokens: 0 } });
    store.close();
  });

  it("commits a terminal event, run projection, and active attempt together", () => {
    const store = new SqliteRunStore(":memory:");
    store.createOrGetRun("run-terminal", request());
    store.createRunAttempt("run-terminal", "attempt-terminal");
    store.appendEvent({ runId: "run-terminal", type: "run.queued", status: "QUEUED" });
    store.appendEvent({ runId: "run-terminal", type: "run.cancelled", status: "CANCELLED" });
    expect(store.getRun("run-terminal")).toMatchObject({ status: "CANCELLED", lastSequence: 3 });
    expect(store.listRunAttempts("run-terminal")).toMatchObject([
      { id: "attempt-terminal", status: "CANCELLED", endedAt: expect.any(String) },
    ]);
    store.close();
  });
});

function request() {
  return {
    agent: "coder",
    workspace: "workspace",
    input: "atomic",
    idempotencyKey: "atomic-key",
    principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
  };
}
