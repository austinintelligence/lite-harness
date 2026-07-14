import { describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

describe("run recovery", () => {
  it("reconciles every nonterminal run exactly once after Manager restart", () => {
    const store = new SqliteRunStore(":memory:");
    const request = {
      agent: "coder",
      workspace: "workspace-1",
      input: "recover me",
      idempotencyKey: "recover-1",
      principal: {
        appId: "app-1",
        tenantId: "tenant-1",
        userId: "user-1",
        scopes: ["runs:create"],
      },
    };
    store.createOrGetRun("run-interrupted", request);
    store.appendEvent({
      runId: "run-interrupted",
      type: "run.queued",
      status: "QUEUED",
      payload: { status: "QUEUED" },
    });

    const service = new RunService(
      store,
      new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()),
    );
    expect(service.reconcileInterruptedRuns()).toBe(1);
    expect(service.reconcileInterruptedRuns()).toBe(0);
    expect(service.getRun("run-interrupted")).toMatchObject({
      status: "ORPHANED",
      errorCode: "manager_restarted",
    });
    expect(service.listEvents("run-interrupted").at(-1)).toMatchObject({ type: "run.orphaned" });
    store.close();
  });
});
