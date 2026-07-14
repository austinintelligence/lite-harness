import type { RunEventType, ToolCall, ToolResult } from "@lite-harness/contracts";
import { createId } from "@lite-harness/domain";
import type { ModelEvent, ModelGateway, ModelMessage } from "@lite-harness/provider-core";
import type { ToolRuntime } from "@lite-harness/runtime";

export interface AgentRuntimeEvent {
  type: RunEventType;
  payload: Record<string, unknown>;
}

export class AgentRunner {
  constructor(
    private readonly model: ModelGateway,
    private readonly tools: ToolRuntime,
    private readonly maxTurns = 8,
  ) {}

  async run(params: {
    input: string;
    workspaceId: string;
    history?: readonly ModelMessage[];
    takeSteering?: () => readonly ModelMessage[];
    beforeToolCall?: (call: ToolCall) => Promise<void>;
    signal?: AbortSignal;
    onEvent: (event: AgentRuntimeEvent) => void;
  }): Promise<void> {
    const messages: ModelMessage[] = params.history?.length
      ? params.history.map((message) => ({ ...message }))
      : [{ role: "user", content: params.input }];

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      params.signal?.throwIfAborted();
      const steering = params.takeSteering?.() ?? [];
      messages.push(...steering.map((message) => ({ ...message })));
      let assistantText = "";
      const toolCalls: ToolCall[] = [];
      let finishReason: "stop" | "tool_calls" | undefined;

      for await (const event of this.model.streamTurn({
        messages,
        ...(params.signal ? { signal: params.signal } : {}),
      })) {
        if (event.type === "text.delta") {
          assistantText += event.delta;
          params.onEvent({
            type: "agent.message.delta",
            payload: { delta: event.delta, turn },
          });
        } else if (event.type === "tool.call") {
          toolCalls.push(event.call);
        } else if (event.type === "usage") {
          params.onEvent({ type: "usage.updated", payload: event });
        } else {
          finishReason = event.finishReason;
        }
      }

      messages.push({ role: "assistant", content: assistantText, toolCalls });
      params.onEvent({
        type: "agent.message.completed",
        payload: { role: "assistant", content: assistantText, turn },
      });

      for (const call of toolCalls) {
        params.onEvent({
          type: "tool.call.requested",
          payload: { callId: call.id, name: call.name, arguments: call.arguments },
        });
        await params.beforeToolCall?.(call);
        const result = await this.tools.execute({
          workspaceId: params.workspaceId,
          call,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        params.onEvent({
          type: "tool.call.completed",
          payload: {
            callId: result.callId,
            ok: result.ok,
            content: result.content,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          },
        });
        messages.push({ role: "tool", content: result.content, toolCallId: result.callId });
      }

      if (finishReason === "stop" && toolCalls.length === 0) {
        return;
      }
      if (finishReason !== "tool_calls" && toolCalls.length === 0) {
        throw new Error("Model turn ended without a stop reason or tool call");
      }
    }

    throw new Error(`Agent exceeded the ${this.maxTurns}-turn limit`);
  }
}

export class FakeModelGateway implements ModelGateway {
  async *streamTurn(params: {
    messages: readonly ModelMessage[];
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent> {
    params.signal?.throwIfAborted();
    const hasToolResult = params.messages.some((message) => message.role === "tool");

    if (!hasToolResult) {
      yield { type: "text.delta", delta: "I will create the requested file. " };
      yield {
        type: "tool.call",
        call: {
          id: createId("tool"),
          name: "write_file",
          arguments: {
            path: "hello.txt",
            content: `Lite-Harness completed: ${params.messages[0]?.content ?? "task"}\n`,
          },
        },
      };
      yield { type: "usage", inputTokens: 12, outputTokens: 8 };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    yield { type: "text.delta", delta: "Created hello.txt successfully." };
    yield { type: "usage", inputTokens: 24, outputTokens: 6 };
    yield { type: "completed", finishReason: "stop" };
  }
}

export type { ToolResult };
export type { ModelEvent, ModelGateway, ModelMessage } from "@lite-harness/provider-core";
