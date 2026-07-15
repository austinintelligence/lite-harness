import type {
  ModelEvent,
  ProviderAdapterEvent,
  ProviderAdapter,
} from "@lite-harness/provider-core";
import { ProviderError, readProviderJson, readSseData } from "@lite-harness/provider-core";

export interface OpenAICompatiblePreset {
  providerId: "openai" | "openrouter" | "xai" | "moonshot" | "minimax" | "gemini";
  baseUrl: string;
  allowedOrigins: readonly string[];
}

export const OPENAI_COMPATIBLE_PRESETS: Readonly<Record<OpenAICompatiblePreset["providerId"], OpenAICompatiblePreset>> = Object.freeze({
  openai: Object.freeze({ providerId: "openai", baseUrl: "https://api.openai.com/v1/", allowedOrigins: ["https://api.openai.com"] }),
  openrouter: Object.freeze({ providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1/", allowedOrigins: ["https://openrouter.ai"] }),
  xai: Object.freeze({ providerId: "xai", baseUrl: "https://api.x.ai/v1/", allowedOrigins: ["https://api.x.ai"] }),
  moonshot: Object.freeze({ providerId: "moonshot", baseUrl: "https://api.moonshot.ai/v1/", allowedOrigins: ["https://api.moonshot.ai"] }),
  minimax: Object.freeze({ providerId: "minimax", baseUrl: "https://api.minimax.io/v1/", allowedOrigins: ["https://api.minimax.io"] }),
  gemini: Object.freeze({ providerId: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", allowedOrigins: ["https://generativelanguage.googleapis.com"] }),
});

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    providerId?: string;
    baseUrl: string;
    allowedOrigins: readonly string[];
    fetch?: typeof globalThis.fetch;
  }) {
    this.providerId = options.providerId ?? "openai";
    this.#baseUrl = new URL(options.baseUrl);
    if (!options.allowedOrigins.includes(this.#baseUrl.origin)) {
      throw new Error(`Provider endpoint origin is not allowlisted: ${this.#baseUrl.origin}`);
    }
    if (!['https:', 'http:'].includes(this.#baseUrl.protocol)) throw new Error("Provider endpoint must use HTTP or HTTPS");
    if (this.#baseUrl.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(this.#baseUrl.hostname)) {
      throw new Error("Plain HTTP provider endpoints must be loopback-local");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(params: Parameters<ProviderAdapter["stream"]>[0]): AsyncIterable<ProviderAdapterEvent> {
    const response = await this.#fetch(new URL("chat/completions", ensureTrailingSlash(this.#baseUrl)), {
      method: "POST",
      headers: {
        authorization: params.credential.authorizationHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model.id,
        stream: true,
        stream_options: { include_usage: true },
        messages: params.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.role === "assistant" && message.toolCalls?.length ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          } : {}),
          ...(message.role === "tool" && message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        })),
        ...(params.tools?.length ? {
          tools: params.tools.map((tool) => ({
            type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })),
          tool_choice: "auto",
        } : {}),
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new ProviderError(
        classifyStatus(response.status),
        `OpenAI-compatible provider returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    yield { type: "request.accepted" };
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      yield* streamOpenAi(response, params.signal);
      return;
    }
    let body: OpenAIResponse;
    body = await readProviderJson(response) as OpenAIResponse;
    const choice = body.choices?.[0];
    if (!choice) throw new ProviderError("invalid_response", "Provider response contained no choices", false);
    if (choice.message.content) yield { type: "text.delta", delta: choice.message.content };
    for (const toolCall of choice.message.tool_calls ?? []) {
      let argumentsValue: Record<string, unknown>;
      try {
        argumentsValue = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        throw new ProviderError("invalid_tool_arguments", "Provider returned invalid JSON tool arguments", false);
      }
      yield { type: "tool.call", call: { id: toolCall.id, name: toolCall.function.name, arguments: argumentsValue } };
    }
    if (body.usage) {
      yield { type: "usage", inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens };
    }
    yield { type: "completed", finishReason: choice.message.tool_calls?.length ? "tool_calls" : "stop" };
  }
}

async function* streamOpenAi(response: Response, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | undefined;
  for await (const data of readSseData(response.body, signal)) {
    if (data === "[DONE]") break;
    let chunk: OpenAIStreamChunk;
    try { chunk = JSON.parse(data) as OpenAIStreamChunk; }
    catch { throw new ProviderError("invalid_response", "Provider returned an invalid SSE payload", false); }
    if (chunk.error) throw new ProviderError("provider_stream_error", "Provider stream reported an error", false);
    if (chunk.usage) yield { type: "usage", inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) yield { type: "text.delta", delta: choice.delta.content };
      for (const part of choice.delta?.tool_calls ?? []) {
        const current = tools.get(part.index) ?? { id: "", name: "", arguments: "" };
        current.id += part.id ?? "";
        current.name += part.function?.name ?? "";
        current.arguments += part.function?.arguments ?? "";
        tools.set(part.index, current);
      }
      finishReason = choice.finish_reason ?? finishReason;
    }
  }
  for (const tool of [...tools.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)) {
    if (!tool.id || !tool.name) throw new ProviderError("invalid_response", "Provider returned an incomplete tool call", false);
    let args: Record<string, unknown>;
    try { args = JSON.parse(tool.arguments || "{}") as Record<string, unknown>; }
    catch { throw new ProviderError("invalid_tool_arguments", "Provider returned invalid JSON tool arguments", false); }
    yield { type: "tool.call", call: { id: tool.id, name: tool.name, arguments: args } };
  }
  yield { type: "completed", finishReason: tools.size > 0 || finishReason === "tool_calls" ? "tool_calls" : "stop" };
}

interface OpenAIResponse {
  choices?: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  error?: unknown;
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

function classifyStatus(status: number): string {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_request_failed";
}
