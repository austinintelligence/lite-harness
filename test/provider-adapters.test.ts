import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@lite-harness/provider-anthropic";
import { OpenAICompatibleProvider } from "@lite-harness/provider-openai-compatible";
import type { ModelDescriptor } from "@lite-harness/provider-core";

const model = (id: string, providerId: string): ModelDescriptor => ({
  id,
  providerId,
  transport: "direct",
  credentialProfileId: "profile-1",
  capabilities: ["text"],
  contextWindow: 128_000,
  provenance: "static",
  enabled: true,
});

describe("direct provider adapters", () => {
  it("normalizes an OpenAI-compatible response", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer upstream-secret" });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = new OpenAICompatibleProvider({
      baseUrl: "https://provider.example/v1/",
      allowedOrigins: ["https://provider.example"],
      fetch,
    });
    const events = [];
    for await (const event of adapter.stream({
      model: model("example-model", "openai"),
      messages: [{ role: "user", content: "hi" }],
      credential: { authorizationHeader: "Bearer upstream-secret" },
    })) events.push(event);
    expect(events).toEqual([
      { type: "text.delta", delta: "hello" },
      { type: "usage", inputTokens: 2, outputTokens: 1 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("normalizes an Anthropic response", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "x-api-key": "upstream-secret" });
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = new AnthropicProvider({ fetch });
    const events = [];
    for await (const event of adapter.stream({
      model: model("claude-example", "anthropic"),
      messages: [{ role: "user", content: "hi" }],
      credential: { authorizationHeader: "Bearer upstream-secret" },
    })) events.push(event);
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
  });
});
