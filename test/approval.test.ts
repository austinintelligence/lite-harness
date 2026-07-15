import { describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

describe("tool approvals and steering", () => {
  it("pauses a tool call until an approval is durably resolved", async () => {
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(
      store,
      new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()),
      { requiresApproval: () => true, approvalTimeoutMs: 2_000 },
    );
    try {
      const created = service.createRun({
        agent: "coder",
        workspace: "workspace-approval",
        input: "write a file",
        idempotencyKey: "approval-run",
        principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
      });
      let approvalId: string | undefined;
      for (let cursor = 0; !approvalId;) {
        const events = await service.waitForEvents(created.runId, cursor, 500);
        cursor = events.at(-1)?.sequence ?? cursor;
        approvalId = events.find((event) => event.type === "approval.requested")?.payload.approvalId as string | undefined;
      }
      expect(service.getApproval(approvalId)).toMatchObject({ status: "PENDING", toolName: "write_file" });
      expect(service.resolveApproval(approvalId, true)).toMatchObject({ status: "APPROVED" });
      expect((await service.waitForTerminal(created.runId)).status).toBe("SUCCEEDED");
      expect(service.listEvents(created.runId).map((event) => event.type)).toContain("approval.resolved");
    } finally {
      store.close();
    }
  });

  it("persists steering as a session message and run event", () => {
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()));
    try {
      const created = service.createRun({
        agent: "coder",
        workspace: "workspace-steer",
        input: "start",
        idempotencyKey: "steer-run",
        principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
      });
      const run = service.steerRun(created.runId, "also explain the result");
      expect(service.listEvents(run.id).map((event) => event.type)).toContain("run.steered");
      expect(service.listSessionMessages(run.sessionId as string, run)).toContainEqual(
        expect.objectContaining({ role: "user", content: "also explain the result", metadata: { steering: true } }),
      );
    } finally {
      store.close();
    }
  });
});
