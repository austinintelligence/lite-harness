import type { InternalPrincipal, RunEventType, ToolCall, ToolResult } from "@lite-harness/contracts";
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
    instructions?: string;
    allowedTools?: readonly string[];
    workspaceId: string;
    runId?: string;
    principal?: InternalPrincipal;
    history?: readonly ModelMessage[];
    takeSteering?: () => readonly ModelMessage[];
    beforeToolCall?: (call: ToolCall) => Promise<void>;
    maxTurns?: number;
    modelIdleTimeoutMs?: number;
    commandTimeoutMs?: number;
    signal?: AbortSignal;
    onEvent: (event: AgentRuntimeEvent) => void;
  }): Promise<void> {
    const messages: ModelMessage[] = [
      ...(params.instructions?.trim() ? [{ role: "system" as const, content: params.instructions.trim() }] : []),
      ...(params.history?.length
        ? params.history.map((message) => ({ ...message }))
        : [{ role: "user" as const, content: params.input }]),
    ];
    const allowed = new Set(params.allowedTools ?? []);
    const advertisedTools = (this.tools.listTools?.() ?? []).filter((tool) => allowed.has(tool.name));

    const turnLimit = params.maxTurns ?? this.maxTurns;
    for (let turn = 0; turn < turnLimit; turn += 1) {
      params.signal?.throwIfAborted();
      const steering = params.takeSteering?.() ?? [];
      messages.push(...steering.map((message) => ({ ...message })));
      let assistantText = "";
      const toolCalls: ToolCall[] = [];
      let finishReason: "stop" | "tool_calls" | undefined;

      const stream = this.model.streamTurn({
        messages,
        ...(advertisedTools.length ? { tools: advertisedTools } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      })[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await nextWithIdleTimeout(
            stream,
            params.modelIdleTimeoutMs ?? 120_000,
            params.signal,
          );
          if (next.done) break;
          const event = next.value;
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
      } finally {
        startBestEffortIteratorCleanup(stream);
      }

      messages.push({ role: "assistant", content: assistantText, toolCalls });
      params.onEvent({
        type: "agent.message.completed",
        payload: { role: "assistant", content: assistantText, toolCalls, turn },
      });

      for (const call of toolCalls) {
        params.onEvent({
          type: "tool.call.requested",
          payload: { callId: call.id, name: call.name, arguments: call.arguments },
        });
        await params.beforeToolCall?.(call);
        const commandSignal = params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(params.commandTimeoutMs ?? 300_000)])
          : AbortSignal.timeout(params.commandTimeoutMs ?? 300_000);
        const result = await this.tools.execute({
          workspaceId: params.workspaceId,
          ...(params.runId ? { runId: params.runId } : {}),
          ...(params.principal ? { principal: params.principal } : {}),
          call,
          signal: commandSignal,
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

    throw new Error(`Agent exceeded the ${turnLimit}-turn limit`);
  }
}

function startBestEffortIteratorCleanup<T>(iterator: AsyncIterator<T>): void {
  if (!iterator.return) return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // A provider cleanup failure must not replace the turn result or defeat its deadline.
  }
}

export class FakeModelGateway implements ModelGateway {
  async *streamTurn(params: {
    messages: readonly ModelMessage[];
    tools?: readonly import("@lite-harness/contracts").ToolDefinition[];
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

async function nextWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Model stream was idle for ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("Run aborted"));
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    signal?.throwIfAborted();
    return await Promise.race([iterator.next(), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}
