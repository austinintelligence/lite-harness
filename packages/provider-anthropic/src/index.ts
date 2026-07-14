import type { ModelEvent, ProviderAdapter } from "@lite-harness/provider-core";
import { ProviderError, readProviderJson, readSseData, type ModelMessage } from "@lite-harness/provider-core";

export class AnthropicProvider implements ProviderAdapter {
  readonly providerId = "anthropic";
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    baseUrl?: string;
    allowedOrigins?: readonly string[];
    fetch?: typeof globalThis.fetch;
  } = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? "https://api.anthropic.com/v1/");
    const allowed = options.allowedOrigins ?? ["https://api.anthropic.com"];
    if (!allowed.includes(this.#baseUrl.origin)) throw new Error(`Provider endpoint origin is not allowlisted: ${this.#baseUrl.origin}`);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(params: Parameters<ProviderAdapter["stream"]>[0]): AsyncIterable<ModelEvent> {
    const response = await this.#fetch(new URL("messages", ensureTrailingSlash(this.#baseUrl)), {
      method: "POST",
      headers: {
        "x-api-key": stripBearer(params.credential.authorizationHeader),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model.id,
        max_tokens: 4096,
        stream: true,
        ...(anthropicSystem(params.messages) ? { system: anthropicSystem(params.messages) } : {}),
        messages: toAnthropicMessages(params.messages),
        ...(params.tools?.length ? { tools: params.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new ProviderError(
        response.status === 429 ? "rate_limited" : response.status >= 500 ? "provider_unavailable" : "provider_request_failed",
        `Anthropic provider returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      yield* streamAnthropic(response, params.signal);
      return;
    }
    let body: AnthropicResponse;
    body = await readProviderJson(response) as AnthropicResponse;
    for (const block of body.content ?? []) {
      if (block.type === "text" && block.text) yield { type: "text.delta", delta: block.text };
      if (block.type === "tool_use" && block.id && block.name) {
        yield { type: "tool.call", call: { id: block.id, name: block.name, arguments: block.input ?? {} } };
      }
    }
    if (body.usage) yield { type: "usage", inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens };
    yield { type: "completed", finishReason: body.stop_reason === "tool_use" ? "tool_calls" : "stop" };
  }
}

async function* streamAnthropic(response: Response, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const tools = new Map<number, { id: string; name: string; input: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;
  for await (const data of readSseData(response.body, signal)) {
    let event: AnthropicStreamEvent;
    try { event = JSON.parse(data) as AnthropicStreamEvent; }
    catch { throw new ProviderError("invalid_response", "Anthropic returned an invalid SSE payload", false); }
    if (event.type === "error") throw new ProviderError("provider_stream_error", "Anthropic stream reported an error", false);
    if (event.type === "message_start") inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      tools.set(event.index ?? tools.size, {
        id: event.content_block.id ?? "", name: event.content_block.name ?? "",
        input: event.content_block.input && Object.keys(event.content_block.input).length > 0
          ? JSON.stringify(event.content_block.input)
          : "",
      });
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      yield { type: "text.delta", delta: event.delta.text };
    }
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      const index = event.index ?? -1;
      const tool = tools.get(index);
      if (tool) tool.input += event.delta.partial_json ?? "";
    }
    if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      outputTokens = event.usage?.output_tokens ?? outputTokens;
    }
  }
  for (const tool of [...tools.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)) {
    if (!tool.id || !tool.name) throw new ProviderError("invalid_response", "Anthropic returned an incomplete tool call", false);
    let input: Record<string, unknown>;
    try { input = JSON.parse(tool.input || "{}") as Record<string, unknown>; }
    catch { throw new ProviderError("invalid_tool_arguments", "Anthropic returned invalid JSON tool arguments", false); }
    yield { type: "tool.call", call: { id: tool.id, name: tool.name, arguments: input } };
  }
  yield { type: "usage", inputTokens, outputTokens };
  yield { type: "completed", finishReason: tools.size > 0 || stopReason === "tool_use" ? "tool_calls" : "stop" };
}

function toAnthropicMessages(messages: readonly ModelMessage[]): Array<{ role: "user" | "assistant"; content: unknown }> {
  const output: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  const append = (role: "user" | "assistant", blocks: unknown[]) => {
    const previous = output.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else output.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      append("assistant", [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
      ]);
    } else if (message.role === "tool") {
      if (!message.toolCallId) throw new ProviderError("invalid_request", "Anthropic tool result is missing its tool call id", false);
      append("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]);
    } else {
      append("user", [{ type: "text", text: message.content }]);
    }
  }
  return output;
}

function anthropicSystem(messages: readonly ModelMessage[]): string {
  return messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
}

interface AnthropicResponse {
  content?: Array<{ type: "text" | "tool_use"; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
}

function stripBearer(value: string): string {
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7) : value;
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}
