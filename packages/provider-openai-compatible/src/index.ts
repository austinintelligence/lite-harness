import type {
  ModelEvent,
  ProviderAdapter,
} from "@lite-harness/provider-core";
import { ProviderError } from "@lite-harness/provider-core";

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
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(params: Parameters<ProviderAdapter["stream"]>[0]): AsyncIterable<ModelEvent> {
    const response = await this.#fetch(new URL("chat/completions", ensureTrailingSlash(this.#baseUrl)), {
      method: "POST",
      headers: {
        authorization: params.credential.authorizationHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model.id,
        stream: false,
        messages: params.messages.map((message) => ({ role: message.role, content: message.content })),
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
    const body = (await response.json()) as OpenAIResponse;
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

interface OpenAIResponse {
  choices?: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
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
