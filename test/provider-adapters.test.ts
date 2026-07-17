import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@lite-harness/provider-anthropic";
import {
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  OpenAIResponsesCompatibleProvider,
  OpenAIResponsesProvider,
} from "@lite-harness/provider-openai-compatible";
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
  it("A22-OFFLINE-REDIRECT-DENIED keeps a loopback-compatible provider on its configured origin", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(input)).origin).toBe("http://127.0.0.1:8645");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://provider.example/escape" } });
    });
    const adapter = new OpenAICompatibleProvider({
      providerId: "openai-compatible", baseUrl: "http://127.0.0.1:8645/v1", allowedOrigins: ["http://127.0.0.1:8645"], fetch,
    });
    await expect(async () => {
      for await (const _event of adapter.stream({
        model: model("offline-local", "openai-compatible"), messages: [{ role: "user", content: "offline" }],
        credential: { authorizationHeader: "Bearer local" },
      })) { /* response must fail before yielding */ }
    }).rejects.toThrow(/HTTP 302/);
    expect(fetch).toHaveBeenCalledOnce();
    for (const baseUrl of ["http://127.0.0.2:8645/v1", "http://agent.localhost:8645/v1"]) {
      expect(() => new OpenAICompatibleProvider({
        providerId: "openai-compatible", baseUrl, allowedOrigins: [new URL(baseUrl).origin], fetch,
      })).toThrow(/loopback/);
    }
  });

  it("A22-CREDENTIAL-REDIRECT-DENIED does not forward an Anthropic key across a redirect", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "x-api-key": "anthropic-secret" });
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://credential-sink.example/" } });
    });
    const adapter = new AnthropicProvider({
      baseUrl: "http://127.0.0.1:8999/v1", allowedOrigins: ["http://127.0.0.1:8999"], fetch,
    });
    await expect(async () => {
      for await (const _event of adapter.stream({
        model: model("claude-local", "anthropic"), messages: [{ role: "user", content: "offline" }],
        credential: { authorizationHeader: "Bearer anthropic-secret" },
      })) { /* a redirect is terminal */ }
    }).rejects.toThrow(/HTTP 302/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("normalizes an OpenAI-compatible response", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer upstream-secret" });
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        messages: [{ role: "system", content: "Be precise" }, { role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "read_file" } }], tool_choice: "auto",
      });
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
      messages: [{ role: "system", content: "Be precise" }, { role: "user", content: "hi" }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      credential: { authorizationHeader: "Bearer upstream-secret" },
    })) events.push(event);
    expect(events).toEqual([
      { type: "request.accepted" },
      { type: "text.delta", delta: "hello" },
      { type: "usage", inputTokens: 2, outputTokens: 1 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it.each(Object.values(OPENAI_COMPATIBLE_PRESETS).filter((preset) => preset.providerId !== "openai"))(
    "streams normalized events through the fixed $providerId endpoint",
    async (preset) => {
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(new URL(String(input)).origin).toBe(preset.allowedOrigins[0]);
        expect(new URL(String(input)).pathname).toBe(new URL("chat/completions", preset.baseUrl).pathname);
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
        return sseResponse([
          { choices: [{ delta: { content: "streamed" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
          "[DONE]",
        ]);
      });
      const adapter = new OpenAICompatibleProvider({ ...preset, fetch });
      const events = [];
      for await (const event of adapter.stream({
        model: model("fixture", preset.providerId), messages: [{ role: "user", content: "hi" }],
        credential: { authorizationHeader: "Bearer fixture-secret" },
      })) events.push(event);
      expect(events).toEqual([
        { type: "request.accepted" },
        { type: "text.delta", delta: "streamed" },
        { type: "usage", inputTokens: 3, outputTokens: 2 },
        { type: "completed", finishReason: "stop" },
      ]);
    },
  );

  it("D26-DIRECT BD-032-REGRESSION uses the native Lite loop with OpenAI Responses contracts", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      expect(init?.redirect).toBe("manual");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-fixture",
        stream: true,
        store: false,
        truncation: "disabled",
        input: [
          { type: "message", role: "user", content: "work" },
          { type: "function_call", call_id: "call-old", name: "read_file", arguments: "{\"path\":\"a\"}" },
          { type: "function_call_output", call_id: "call-old", output: "contents" },
        ],
        tools: [{ type: "function", name: "write_file", parameters: { type: "object" }, strict: true }],
        tool_choice: "auto",
      });
      return sseResponse([
        { type: "response.created", sequence_number: 0, response: { id: "resp-1", status: "in_progress" } },
        { type: "response.output_text.delta", sequence_number: 1, delta: "working" },
        { type: "response.output_item.added", sequence_number: 2, output_index: 1, item: { id: "fc-1", type: "function_call", call_id: "call-new", name: "write_file", arguments: "" } },
        { type: "response.function_call_arguments.delta", sequence_number: 3, output_index: 1, item_id: "fc-1", delta: "{\"path\":" },
        { type: "response.function_call_arguments.done", sequence_number: 4, output_index: 1, item_id: "fc-1", name: "write_file", arguments: "{\"path\":\"b\"}" },
        { type: "response.completed", sequence_number: 5, response: { status: "completed", usage: { input_tokens: 11, output_tokens: 4 } } },
      ]);
    });
    const adapter = new OpenAIResponsesProvider({ fetch });
    expect(adapter.apiOperation).toBe("responses.create");
    const events = [];
    for await (const event of adapter.stream({
      model: model("gpt-fixture", "openai"),
      messages: [
        { role: "user", content: "work" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-old", name: "read_file", arguments: { path: "a" } }] },
        { role: "tool", content: "contents", toolCallId: "call-old" },
      ],
      tools: [{ name: "write_file", description: "Write", inputSchema: { type: "object" } }],
      credential: { authorizationHeader: "Bearer fixture-secret" },
    })) events.push(event);
    expect(events).toEqual([
      { type: "request.accepted" },
      { type: "text.delta", delta: "working" },
      { type: "tool.call", call: { id: "call-new", name: "write_file", arguments: { path: "b" } } },
      { type: "usage", inputTokens: 11, outputTokens: 4 },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("normalizes non-streamed OpenAI Responses and rejects incomplete terminal states", async () => {
    const completed = new OpenAIResponsesProvider({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        id: "resp-json",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
        usage: { input_tokens: 2, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    const completedEvents = [];
    for await (const event of completed.stream({
      model: model("gpt-fixture", "openai"), messages: [{ role: "user", content: "go" }],
      credential: { authorizationHeader: "Bearer fixture-secret" },
    })) completedEvents.push(event);
    expect(completedEvents).toContainEqual({ type: "text.delta", delta: "done" });

    const incomplete = new OpenAIResponsesProvider({
      fetch: vi.fn(async () => sseResponse([
        { type: "response.incomplete", sequence_number: 0, response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 2 } } },
      ])),
    });
    const iterator = incomplete.stream({
      model: model("gpt-fixture", "openai"), messages: [{ role: "user", content: "go" }],
      credential: { authorizationHeader: "Bearer fixture-secret" },
    })[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: { type: "request.accepted" }, done: false });
    expect(await iterator.next()).toEqual({ value: { type: "usage", inputTokens: 5, outputTokens: 2 }, done: false });
    await expect(iterator.next()).rejects.toMatchObject({ code: "response_incomplete" });
  });

  it("uses the Responses-compatible route and accepts Hermes octet-stream SSE framing", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8645/v1/responses");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-5.6-luna",
        stream: true,
        input: [{ type: "message", role: "user", content: "invoke" }],
        tools: [{ type: "function", name: "write_file" }],
        tool_choice: "auto",
      });
      return sseResponse([
        { type: "response.created", sequence_number: 0, response: { status: "in_progress" } },
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "write_file", arguments: "" } },
        { type: "response.function_call_arguments.done", sequence_number: 2, output_index: 0, item_id: "fc-1", call_id: "call-1", name: "write_file", arguments: '{"path":"probe.txt","content":"PROBE_OK"}' },
        { type: "response.completed", sequence_number: 3, response: { status: "completed", usage: null } },
      ], "application/octet-stream");
    });
    const adapter = new OpenAIResponsesCompatibleProvider({
      providerId: "openai-compatible",
      baseUrl: "http://127.0.0.1:8645/v1",
      allowedOrigins: ["http://127.0.0.1:8645"],
      fetch,
    });
    const events = [];
    for await (const event of adapter.stream({
      model: model("gpt-5.6-luna", "openai-compatible"),
      messages: [{ role: "user", content: "invoke" }],
      tools: [{ name: "write_file", description: "Write a file", inputSchema: { type: "object" } }],
      credential: { authorizationHeader: "Bearer sk-hermes-local" },
    })) events.push(event);
    expect(events).toEqual([
      { type: "request.accepted" },
      { type: "tool.call", call: { id: "call-1", name: "write_file", arguments: { path: "probe.txt", content: "PROBE_OK" } } },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("preserves tool-call and tool-result pairing in OpenAI-compatible requests", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      expect(body.messages[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call-1" }] });
      expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-2", function: { name: "write_file", arguments: "{\"path\":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]);
    });
    const adapter = new OpenAICompatibleProvider({
      providerId: "openai", baseUrl: "https://api.openai.com/v1/", allowedOrigins: ["https://api.openai.com"], fetch,
    });
    const events = [];
    for await (const event of adapter.stream({
      model: model("fixture", "openai"),
      messages: [
        { role: "user", content: "work" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "x" } }] },
        { role: "tool", content: "contents", toolCallId: "call-1" },
      ],
      credential: { authorizationHeader: "Bearer fixture-secret" },
    })) events.push(event);
    expect(events).toContainEqual({ type: "tool.call", call: { id: "call-2", name: "write_file", arguments: { path: "x" } } });
  });

  it("rejects OpenAI-compatible Chat Completions EOF after text without [DONE]", async () => {
    const adapter = new OpenAICompatibleProvider({
      providerId: "openai", baseUrl: "https://api.openai.com/v1/", allowedOrigins: ["https://api.openai.com"],
      fetch: vi.fn(async () => sseResponse([
        { choices: [{ delta: { content: "partial" }, finish_reason: null }] },
      ])),
    });
    const events: unknown[] = [];
    await expect((async () => {
      for await (const event of adapter.stream({
        model: model("fixture", "openai"), messages: [{ role: "user", content: "work" }],
        credential: { authorizationHeader: "Bearer fixture-secret" },
      })) events.push(event);
    })()).rejects.toMatchObject({ code: "provider_stream_truncated" });
    expect(events).toEqual([
      { type: "request.accepted" },
      { type: "text.delta", delta: "partial" },
    ]);
  });

  it("rejects OpenAI-compatible Chat Completions EOF during fragmented tool arguments", async () => {
    const adapter = new OpenAICompatibleProvider({
      providerId: "openai", baseUrl: "https://api.openai.com/v1/", allowedOrigins: ["https://api.openai.com"],
      fetch: vi.fn(async () => sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":"' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "a\"" } }] }, finish_reason: null }] },
      ])),
    });
    const events: unknown[] = [];
    await expect((async () => {
      for await (const event of adapter.stream({
        model: model("fixture", "openai"), messages: [{ role: "user", content: "work" }],
        credential: { authorizationHeader: "Bearer fixture-secret" },
      })) events.push(event);
    })()).rejects.toMatchObject({ code: "provider_stream_truncated" });
    expect(events).toEqual([{ type: "request.accepted" }]);
  });

  it("normalizes an Anthropic response", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "x-api-key": "upstream-secret" });
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toMatchObject({ system: "Be precise", tools: [{ name: "read_file" }] });
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
      messages: [{ role: "system", content: "Be precise" }, { role: "user", content: "hi" }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      credential: { authorizationHeader: "Bearer upstream-secret" },
    })) events.push(event);
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
  });

  it("BD-033-REGRESSION rejects non-loopback plaintext Anthropic endpoints before credential-bearing I/O", async () => {
    const fetch = vi.fn();
    expect(() => new AnthropicProvider({
      baseUrl: "http://anthropic.example/v1/",
      allowedOrigins: ["http://anthropic.example"],
      fetch,
    })).toThrow(/plaintext Anthropic endpoints must be loopback/);
    expect(() => new AnthropicProvider({
      baseUrl: "https://user:password@api.anthropic.com/v1/",
      allowedOrigins: ["https://api.anthropic.com"],
      fetch,
    })).toThrow(/embedded credentials|allowlisted/);
    expect(fetch).not.toHaveBeenCalled();

    expect(() => new AnthropicProvider({
      baseUrl: "http://127.0.0.2:8999/v1/", allowedOrigins: ["http://127.0.0.2:8999"], fetch,
    })).toThrow(/loopback/);

    const local = new AnthropicProvider({
      baseUrl: "http://127.0.0.1:8999/v1/",
      allowedOrigins: ["http://127.0.0.1:8999"],
      fetch: vi.fn(async () => new Response(JSON.stringify({
        content: [{ type: "text", text: "local" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    const events = [];
    for await (const event of local.stream({
      model: model("claude-local", "anthropic"), messages: [{ role: "user", content: "hi" }],
      credential: { authorizationHeader: "Bearer placeholder" },
    })) events.push(event);
    expect(events).toContainEqual({ type: "text.delta", delta: "local" });
  });

  it("streams Anthropic text, usage, and tool calls with paired tool results", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { stream: boolean; messages: Array<{ role: string; content: unknown[] }> };
      expect(body.stream).toBe(true);
      expect(body.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "old-tool" }] });
      return sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 4 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "new-tool", name: "read_file", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    });
    const adapter = new AnthropicProvider({ fetch });
    const events = [];
    for await (const event of adapter.stream({
      model: model("claude-fixture", "anthropic"),
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "old-tool", name: "read_file", arguments: { path: "x" } }] },
        { role: "tool", content: "contents", toolCallId: "old-tool" },
      ],
      credential: { authorizationHeader: "Bearer fixture-secret" },
    })) events.push(event);
    expect(events).toContainEqual({ type: "text.delta", delta: "hello" });
    expect(events).toContainEqual({ type: "tool.call", call: { id: "new-tool", name: "read_file", arguments: { path: "a" } } });
    expect(events).toContainEqual({ type: "usage", inputTokens: 4, outputTokens: 3 });
  });

  it("rejects Anthropic SSE EOF after text without message_stop", async () => {
    const adapter = new AnthropicProvider({
      fetch: vi.fn(async () => sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 4 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      ])),
    });
    const events: unknown[] = [];
    await expect((async () => {
      for await (const event of adapter.stream({
        model: model("claude-fixture", "anthropic"), messages: [{ role: "user", content: "work" }],
        credential: { authorizationHeader: "Bearer fixture-secret" },
      })) events.push(event);
    })()).rejects.toMatchObject({ code: "provider_stream_truncated" });
    expect(events).toEqual([
      { type: "request.accepted" },
      { type: "text.delta", delta: "partial" },
    ]);
  });

  it("rejects Anthropic SSE EOF during fragmented tool arguments", async () => {
    const adapter = new AnthropicProvider({
      fetch: vi.fn(async () => sseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read_file", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "a\"" } },
      ])),
    });
    const events: unknown[] = [];
    await expect((async () => {
      for await (const event of adapter.stream({
        model: model("claude-fixture", "anthropic"), messages: [{ role: "user", content: "work" }],
        credential: { authorizationHeader: "Bearer fixture-secret" },
      })) events.push(event);
    })()).rejects.toMatchObject({ code: "provider_stream_truncated" });
    expect(events).toEqual([{ type: "request.accepted" }]);
  });
});

function sseResponse(events: readonly unknown[], contentType = "text/event-stream"): Response {
  const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}
