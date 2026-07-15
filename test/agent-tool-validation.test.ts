import { describe, expect, it } from "vitest";
import type { ToolCall, ToolDefinition, ToolResult } from "@lite-harness/contracts";
import { AgentRunner, ToolArgumentValidationError } from "@lite-harness/agent-runtime";
import type { ModelEvent, ModelGateway, ModelMessage } from "@lite-harness/provider-core";
import type { ToolExecutionContext, ToolRuntime } from "@lite-harness/runtime";

class SingleCallModel implements ModelGateway {
  turns = 0;

  constructor(private readonly call: ToolCall) {}

  async *streamTurn(params: { messages: readonly ModelMessage[] }): AsyncIterable<ModelEvent> {
    this.turns += 1;
    if (params.messages.some((message) => message.role === "tool")) {
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    yield { type: "tool.call", call: this.call };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class SchemaRuntime implements ToolRuntime {
  executions = 0;

  constructor(private readonly definitions: ToolDefinition[]) {}

  listTools(): ToolDefinition[] {
    return this.definitions;
  }

  async execute(context: ToolExecutionContext): Promise<ToolResult> {
    this.executions += 1;
    return { callId: context.call.id, ok: true, content: "ok" };
  }
}

const writeFileDefinition: ToolDefinition = {
  name: "write_file",
  description: "write a file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

async function runOne(model: ModelGateway, runtime: ToolRuntime, beforeToolCall?: () => Promise<void>) {
  await new AgentRunner(model, runtime).run({
    input: "write",
    allowedTools: ["write_file"],
    workspaceId: "workspace",
    ...(beforeToolCall ? { beforeToolCall } : {}),
    onEvent: () => undefined,
  });
}

describe("advertised tool schema enforcement", () => {
  it("BD-029-REGRESSION rejects schema-invalid arguments before approval or dispatch", async () => {
    const model = new SingleCallModel({
      id: "call_invalid",
      name: "write_file",
      arguments: { path: 17, content: "data", unexpected: true },
    });
    const runtime = new SchemaRuntime([writeFileDefinition]);
    let approvalChecks = 0;

    await expect(runOne(model, runtime, async () => { approvalChecks += 1; })).rejects.toMatchObject({
      code: "invalid_tool_arguments",
    });
    expect(approvalChecks).toBe(0);
    expect(runtime.executions).toBe(0);
  });

  it("rejects calls that were not in the exact advertised tool set", async () => {
    const runtime = new SchemaRuntime([writeFileDefinition]);
    const model = new SingleCallModel({ id: "call_hidden", name: "hidden_tool", arguments: {} });
    await expect(runOne(model, runtime)).rejects.toMatchObject({ code: "tool_not_advertised" });
    expect(runtime.executions).toBe(0);
  });

  it("executes a call that matches the exact advertised schema", async () => {
    const runtime = new SchemaRuntime([writeFileDefinition]);
    const model = new SingleCallModel({
      id: "call_valid",
      name: "write_file",
      arguments: { path: "result.txt", content: "data" },
    });
    await runOne(model, runtime);
    expect(runtime.executions).toBe(1);
  });

  it("fails closed before the model turn when an advertised schema is invalid", async () => {
    const model = new SingleCallModel({ id: "unused", name: "write_file", arguments: {} });
    const runtime = new SchemaRuntime([{
      name: "write_file",
      description: "invalid schema",
      inputSchema: { type: "definitely-not-a-json-schema-type" },
    }]);
    await expect(runOne(model, runtime)).rejects.toBeInstanceOf(ToolArgumentValidationError);
    expect(model.turns).toBe(0);
    expect(runtime.executions).toBe(0);
  });
});
