import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolCall, ToolResult } from "@lite-harness/contracts";
import { AgentRunner } from "@lite-harness/agent-runtime";
import {
  RunService,
  approvalArgumentsDigest,
  approvalExecutionDigest,
} from "@lite-harness/control-plane";
import type { ModelEvent, ModelGateway, ModelMessage } from "@lite-harness/provider-core";
import type { ToolExecutionContext, ToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

class SharedCallModel implements ModelGateway {
  constructor(readonly call: ToolCall) {}

  async *streamTurn(params: {
    messages: readonly ModelMessage[];
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent> {
    params.signal?.throwIfAborted();
    if (params.messages.some((message) => message.role === "tool")) {
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    yield { type: "tool.call", call: this.call };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class RecordingRuntime implements ToolRuntime {
  executions = 0;

  listTools(): ToolDefinition[] {
    return [{
      name: "write_file",
      description: "write a file",
      inputSchema: { type: "object" },
    }];
  }

  async execute(context: ToolExecutionContext): Promise<ToolResult> {
    this.executions += 1;
    return { callId: context.call.id, ok: true, content: "ok" };
  }
}

async function waitForApproval(service: RunService, runId: string): Promise<string> {
  let cursor = 0;
  while (true) {
    const events = await service.waitForEvents(runId, cursor, 1_000);
    cursor = events.at(-1)?.sequence ?? cursor;
    const id = events.find((event) => event.type === "approval.requested")?.payload.approvalId;
    if (typeof id === "string") return id;
  }
}

function startApprovedRun(routeGeneration: () => string) {
  const store = new SqliteRunStore(":memory:");
  const call: ToolCall = {
    id: "tool_bound_call",
    name: "write_file",
    arguments: { path: "result.txt", content: "approved" },
  };
  const runtime = new RecordingRuntime();
  const service = new RunService(
    store,
    new AgentRunner(new SharedCallModel(call), runtime),
    {
      requiresApproval: () => true,
      approvalTimeoutMs: 2_000,
      approvalRouteGeneration: routeGeneration,
    },
  );
  const created = service.createRun({
    agent: "coder",
    workspace: "workspace-approval-binding",
    input: "write a file",
    idempotencyKey: `approval-binding-${Math.random()}`,
    principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
  });
  return { store, service, call, runtime, runId: created.runId };
}

describe("immutable approval execution binding", () => {
  it("BD-028-REGRESSION binds exact arguments, owner, workspace, route, policy and expiry", async () => {
    let routeGeneration = "route-generation-1";
    const fixture = startApprovedRun(() => routeGeneration);
    try {
      const approvalId = await waitForApproval(fixture.service, fixture.runId);
      const approval = fixture.service.getApproval(approvalId)!;
      expect(approval).toMatchObject({
        runId: fixture.runId,
        toolCallId: fixture.call.id,
        toolName: fixture.call.name,
        toolArgumentsDigest: approvalArgumentsDigest(fixture.call.arguments),
        appId: "app",
        tenantId: "tenant",
        userId: "user",
        workspaceId: "workspace-approval-binding",
        policyGeneration: 1,
        routeGeneration,
        status: "PENDING",
      });
      expect(approval.executionDigest).toBe(approvalExecutionDigest({
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        toolArgumentsDigest: approval.toolArgumentsDigest,
        appId: approval.appId,
        tenantId: approval.tenantId,
        userId: approval.userId,
        workspaceId: approval.workspaceId,
        policyGeneration: approval.policyGeneration,
        routeGeneration: approval.routeGeneration,
        expiresAt: approval.expiresAt,
      }));

      routeGeneration = "route-generation-2";
      expect(fixture.service.resolveApproval(approvalId, true)?.status).toBe("DENIED");
      expect((await fixture.service.waitForTerminal(fixture.runId)).status).toBe("FAILED");
      expect(fixture.runtime.executions).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  it("revalidates the exact call immediately before the tool mutation boundary", async () => {
    let mutateDuringResolution = false;
    let fixture: ReturnType<typeof startApprovedRun>;
    fixture = startApprovedRun(() => {
      if (mutateDuringResolution) fixture.call.arguments.content = "tampered-after-resolution";
      return "route-generation-1";
    });
    try {
      const approvalId = await waitForApproval(fixture.service, fixture.runId);
      mutateDuringResolution = true;
      expect(fixture.service.resolveApproval(approvalId, true)?.status).toBe("APPROVED");

      const terminal = await fixture.service.waitForTerminal(fixture.runId);
      expect(terminal.status).toBe("FAILED");
      expect(terminal.errorMessage).toContain("binding changed");
      expect(fixture.runtime.executions).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  it("canonicalizes argument object keys before hashing", () => {
    expect(approvalArgumentsDigest({ alpha: 1, beta: { x: true, y: false } })).toBe(
      approvalArgumentsDigest({ beta: { y: false, x: true }, alpha: 1 }),
    );
  });
});
