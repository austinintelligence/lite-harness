import type { ModelEvent, ProviderAdapter } from "@lite-harness/provider-core";
import { ProviderError } from "@lite-harness/provider-core";

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
        messages: params.messages
          .filter((message) => message.role !== "tool")
          .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content })),
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
    const body = (await response.json()) as AnthropicResponse;
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

interface AnthropicResponse {
  content?: Array<{ type: "text" | "tool_use"; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

function stripBearer(value: string): string {
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7) : value;
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}
