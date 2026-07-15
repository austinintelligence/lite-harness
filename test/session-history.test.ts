import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "@lite-harness/agent-runtime";
import type { ToolCall } from "@lite-harness/contracts";
import { RunService } from "@lite-harness/control-plane";
import type { ModelEvent, ModelGateway, ModelMessage } from "@lite-harness/provider-core";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const stores: SqliteRunStore[] = [];
const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("durable session history", () => {
  it("BD-010-REGRESSION returns the newest limited window in chronological order", () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const created = store.createOrGetRun("run-history", request("initial", "history-key"));
    for (let index = 1; index <= 4; index += 1) {
      store.appendSessionMessage({
        id: `msg_history_${index}`,
        sessionId: created.run.sessionId as string,
        runId: created.run.id,
        role: "assistant",
        content: `message-${index}`,
      });
    }

    expect(store.listSessionMessages(created.run.sessionId as string, principal, 2).map((item) => item.content))
      .toEqual(["message-3", "message-4"]);
  });

  it("BD-011-REGRESSION persists assistant tool calls and restores them beside tool results", async () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const gateway = new HistoryGateway();
    const service = new RunService(store, new AgentRunner(gateway, new InMemoryToolRuntime()));

    const first = service.createRun(request("write the file", "tool-run"));
    expect((await service.waitForTerminal(first.runId)).status).toBe("SUCCEEDED");
    gateway.captureNextRun = true;
    const second = service.createRun(request("summarize the file", "summary-run"));
    expect((await service.waitForTerminal(second.runId)).status).toBe("SUCCEEDED");

    const assistant = gateway.captured.find((message) => message.role === "assistant" && message.toolCalls?.length);
    const tool = gateway.captured.find((message) => message.role === "tool");
    expect(assistant?.toolCalls).toEqual([
      { id: "call-history", name: "write_file", arguments: { path: "history.txt", content: "durable" } },
    ]);
    expect(tool).toMatchObject({ role: "tool", toolCallId: "call-history" });
  });
});

class HistoryGateway implements ModelGateway {
  captureNextRun = false;
  captured: readonly ModelMessage[] = [];

  async *streamTurn(params: { messages: readonly ModelMessage[] }): AsyncIterable<ModelEvent> {
    if (this.captureNextRun) {
      this.captured = params.messages.map((message) => ({
        ...message,
        ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) } : {}),
      }));
      yield { type: "text.delta", delta: "summary complete" };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    if (params.messages.some((message) => message.role === "tool")) {
      yield { type: "text.delta", delta: "file complete" };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const call: ToolCall = {
      id: "call-history",
      name: "write_file",
      arguments: { path: "history.txt", content: "durable" },
    };
    yield { type: "tool.call", call };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

function request(input: string, idempotencyKey: string) {
  return {
    agent: "coder",
    workspace: "workspace",
    session: "shared-session",
    input,
    idempotencyKey,
    principal,
  };
}
