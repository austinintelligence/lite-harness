import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRecord } from "@lite-harness/contracts";
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

  it("rejects events and usage after a run becomes terminal", () => {
    const store = new SqliteRunStore(":memory:");
    store.createOrGetRun("run-final", request());
    store.appendEvent({ runId: "run-final", type: "run.queued", status: "QUEUED" });
    store.appendEvent({ runId: "run-final", type: "run.cancelled", status: "CANCELLED" });

    expect(() => store.appendEvent({
      runId: "run-final", type: "usage.updated", usage: { inputTokens: 7 },
    })).toThrow(/terminal.*cannot append event/);
    expect(() => store.recordUsage("run-final", { outputTokens: 3 })).toThrow(/terminal.*cannot record usage/);
    expect(() => store.appendSessionMessage({
      id: "msg-late", sessionId: "ses_final", runId: "run-final", role: "assistant", content: "late",
    })).toThrow(/terminal.*cannot append a session message/);
    expect(store.listEvents("run-final")).toHaveLength(3);
    expect(store.getRun("run-final")).toMatchObject({ status: "CANCELLED", usage: { inputTokens: 0, outputTokens: 0 } });
    expect(store.listSessionMessages("ses_final", request().principal)).toHaveLength(1);
    store.close();
  });

  it("does not resolve an approval after its run becomes terminal", () => {
    const store = new SqliteRunStore(":memory:");
    const created = store.createOrGetRun("run-approval-final", request());
    const approval: ApprovalRecord = {
      id: "approval-final",
      runId: created.run.id,
      toolCallId: "call-final",
      toolName: "write_file",
      toolArgumentsDigest: "a".repeat(64),
      executionDigest: "b".repeat(64),
      appId: "app",
      tenantId: "tenant",
      userId: "user",
      workspaceId: "workspace",
      policyGeneration: 1,
      routeGeneration: "route-v1",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    store.createApproval(approval);
    store.appendEvent({ runId: created.run.id, type: "run.cancelled", status: "CANCELLED" });

    expect(store.resolveApprovalAndAppendEvent(
      approval.id,
      "DENIED",
      approval.executionDigest,
      { approvalId: approval.id, status: "DENIED", executionDigest: approval.executionDigest },
    )).toMatchObject({ status: "PENDING" });
    expect(store.getApproval(approval.id)).toMatchObject({ status: "PENDING" });
    expect(store.listEvents(created.run.id)).toHaveLength(2);
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
