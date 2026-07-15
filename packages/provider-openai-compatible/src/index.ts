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

/** Native OpenAI direct route. Generic compatible endpoints remain on Chat Completions below. */
export class OpenAIResponsesProvider implements ProviderAdapter {
  readonly providerId = "openai";
  readonly apiOperation = "responses.create";
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: { fetch?: typeof globalThis.fetch } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(params: Parameters<ProviderAdapter["stream"]>[0]): AsyncIterable<ProviderAdapterEvent> {
    const response = await this.#fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: params.credential.authorizationHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model.id,
        stream: true,
        store: false,
        truncation: "disabled",
        input: toResponsesInput(params.messages),
        ...(params.tools?.length ? {
          tools: params.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: true,
          })),
          tool_choice: "auto",
        } : {}),
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new ProviderError(
        classifyStatus(response.status),
        `OpenAI Responses returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    yield { type: "request.accepted" };
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      yield* streamOpenAiResponses(response, params.signal);
      return;
    }
    yield* normalizeOpenAiResponse(await readProviderJson(response) as OpenAIResponsesBody);
  }
}

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
          content: toChatCompletionsContent(message),
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
      yield {
        type: "usage", inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens,
        ...(body.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: body.usage.prompt_tokens_details.cached_tokens } : {}),
      };
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
    if (chunk.usage) yield {
      type: "usage", inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens,
      ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens } : {}),
    };
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

type ResponsesInputItem =
  | { type: "message"; role: "system" | "user" | "assistant"; content: string | ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function toResponsesInput(messages: Parameters<ProviderAdapter["stream"]>[0]["messages"]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId) {
        throw new ProviderError("invalid_request", "A tool result requires its function call id", false);
      }
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.content || message.imageDataUrls?.length) {
      input.push({ type: "message", role: message.role, content: toResponsesContent(message) });
    }
    for (const call of message.role === "assistant" ? message.toolCalls ?? [] : []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return input;
}

type MessageWithImages = Parameters<ProviderAdapter["stream"]>[0]["messages"][number];
type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" };

function toChatCompletionsContent(message: MessageWithImages): string | Array<
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "auto" } }
> {
  const images = validatedImages(message);
  if (!images.length) return message.content;
  return [
    ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
    ...images.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "auto" as const } })),
  ];
}

function toResponsesContent(message: MessageWithImages): string | ResponsesContentPart[] {
  const images = validatedImages(message);
  if (!images.length) return message.content;
  return [
    ...(message.content ? [{ type: "input_text" as const, text: message.content }] : []),
    ...images.map((image_url) => ({ type: "input_image" as const, image_url, detail: "auto" as const })),
  ];
}

function validatedImages(message: MessageWithImages): readonly string[] {
  const images = message.imageDataUrls ?? [];
  if (!images.length) return images;
  if (message.role !== "user") throw new ProviderError("invalid_request", "Image context must use the user role", false);
  let bytes = 0;
  for (const image of images) {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) throw new ProviderError("invalid_request", "Image context must be a PNG or JPEG data URL", false);
    bytes += Buffer.from(match[2] as string, "base64").byteLength;
    if (bytes > 32 * 1024 * 1024) throw new ProviderError("invalid_request", "Image context exceeds the 32 MiB request limit", false);
  }
  return images;
}

interface OpenAIResponsesBody {
  id?: string;
  status?: "completed" | "failed" | "incomplete" | "cancelled" | "queued" | "in_progress";
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: OpenAIResponseOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null;
}

interface OpenAIResponseOutputItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface OpenAIResponseStreamEvent {
  type?: string;
  sequence_number?: number;
  delta?: string;
  arguments?: string;
  call_id?: string;
  item_id?: string;
  name?: string;
  output_index?: number;
  item?: OpenAIResponseOutputItem;
  response?: OpenAIResponsesBody;
  code?: string;
  message?: string;
}

interface PendingResponseCall {
  itemId?: string;
  callId?: string;
  name?: string;
  arguments: string;
}

async function* streamOpenAiResponses(response: Response, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const calls = new Map<number, PendingResponseCall>();
  let lastSequence = -1;
  let terminal = false;
  for await (const data of readSseData(response.body, signal)) {
    let event: OpenAIResponseStreamEvent;
    try { event = JSON.parse(data) as OpenAIResponseStreamEvent; }
    catch { throw new ProviderError("invalid_response", "OpenAI Responses returned an invalid SSE payload", false); }
    if (!event.type) throw new ProviderError("invalid_response", "OpenAI Responses event omitted its type", false);
    if (event.sequence_number !== undefined) {
      if (!Number.isSafeInteger(event.sequence_number) || event.sequence_number <= lastSequence) {
        throw new ProviderError("invalid_response", "OpenAI Responses event sequence was invalid", false);
      }
      lastSequence = event.sequence_number;
    }
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (typeof event.delta !== "string") throw new ProviderError("invalid_response", "OpenAI Responses text event omitted its delta", false);
      if (event.delta) yield { type: "text.delta", delta: event.delta };
      continue;
    }
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      if (event.item?.type === "function_call") mergeResponseCall(calls, event.output_index, event.item);
      continue;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const call = responseCall(calls, event.output_index);
      call.itemId = event.item_id ?? call.itemId;
      call.arguments += event.delta ?? "";
      continue;
    }
    if (event.type === "response.function_call_arguments.done") {
      const call = responseCall(calls, event.output_index);
      call.itemId = event.item_id ?? call.itemId;
      call.callId = event.call_id ?? call.callId;
      call.name = event.name ?? call.name;
      call.arguments = event.arguments ?? call.arguments;
      continue;
    }
    if (event.type === "response.completed") {
      terminal = true;
      mergeResponseOutput(calls, event.response?.output);
      yield* emitResponseCalls(calls);
      yield* emitResponsesUsage(event.response?.usage);
      yield { type: "completed", finishReason: calls.size ? "tool_calls" : "stop" };
      continue;
    }
    if (event.type === "response.incomplete") {
      terminal = true;
      yield* emitResponsesUsage(event.response?.usage);
      throw responseTerminalError("response_incomplete", event.response);
    }
    if (event.type === "response.failed") {
      terminal = true;
      yield* emitResponsesUsage(event.response?.usage);
      throw responseTerminalError("provider_response_failed", event.response);
    }
    if (event.type === "error") {
      terminal = true;
      throw new ProviderError(event.code ?? "provider_stream_error", event.message ?? "OpenAI Responses stream reported an error", false);
    }
  }
  if (!terminal) throw new ProviderError("invalid_response", "OpenAI Responses stream ended without a terminal event", false);
}

async function* normalizeOpenAiResponse(body: OpenAIResponsesBody): AsyncIterable<ModelEvent> {
  if (body.status === "failed" || body.status === "incomplete" || body.status === "cancelled" || body.error) {
    yield* emitResponsesUsage(body.usage);
    throw responseTerminalError(body.status === "incomplete" ? "response_incomplete" : "provider_response_failed", body);
  }
  if (body.status !== "completed") {
    throw new ProviderError("invalid_response", "OpenAI Responses returned a non-terminal response", false);
  }
  const calls = new Map<number, PendingResponseCall>();
  for (const [index, item] of (body.output ?? []).entries()) {
    if (item.type === "message") {
      for (const content of item.content ?? []) {
        const text = content.type === "refusal" ? content.refusal : content.text;
        if (text) yield { type: "text.delta", delta: text };
      }
    } else if (item.type === "function_call") {
      mergeResponseCall(calls, index, item);
    }
  }
  yield* emitResponseCalls(calls);
  yield* emitResponsesUsage(body.usage);
  yield { type: "completed", finishReason: calls.size ? "tool_calls" : "stop" };
}

function responseCall(calls: Map<number, PendingResponseCall>, index = 0): PendingResponseCall {
  const existing = calls.get(index);
  if (existing) return existing;
  const created: PendingResponseCall = { arguments: "" };
  calls.set(index, created);
  return created;
}

function mergeResponseCall(calls: Map<number, PendingResponseCall>, index = 0, item: OpenAIResponseOutputItem): void {
  const call = responseCall(calls, index);
  call.itemId = item.id ?? call.itemId;
  call.callId = item.call_id ?? call.callId;
  call.name = item.name ?? call.name;
  if (item.arguments !== undefined) call.arguments = item.arguments;
}

function mergeResponseOutput(calls: Map<number, PendingResponseCall>, output: OpenAIResponsesBody["output"]): void {
  for (const [index, item] of (output ?? []).entries()) {
    if (item.type === "function_call") mergeResponseCall(calls, index, item);
  }
}

async function* emitResponseCalls(calls: Map<number, PendingResponseCall>): AsyncIterable<ModelEvent> {
  for (const [, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
    if (!call.callId || !call.name) {
      throw new ProviderError("invalid_response", "OpenAI Responses returned an incomplete function call", false);
    }
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.arguments || "{}") as Record<string, unknown>; }
    catch { throw new ProviderError("invalid_tool_arguments", "OpenAI Responses returned invalid JSON function arguments", false); }
    if (!args || Array.isArray(args) || typeof args !== "object") {
      throw new ProviderError("invalid_tool_arguments", "OpenAI Responses function arguments must be a JSON object", false);
    }
    yield { type: "tool.call", call: { id: call.callId, name: call.name, arguments: args } };
  }
}

async function* emitResponsesUsage(usage: OpenAIResponsesBody["usage"]): AsyncIterable<ModelEvent> {
  if (!usage) return;
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) {
    throw new ProviderError("invalid_usage", "OpenAI Responses returned invalid token usage", false);
  }
  yield {
    type: "usage", inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number,
    ...(usage.input_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: usage.input_tokens_details.cached_tokens } : {}),
  };
}

function responseTerminalError(code: string, response: OpenAIResponsesBody | undefined): ProviderError {
  const reason = response?.error?.message ?? response?.incomplete_details?.reason;
  return new ProviderError(response?.error?.code ?? code, reason ? `OpenAI Responses did not complete: ${reason}` : "OpenAI Responses did not complete", false);
}

interface OpenAIResponse {
  choices?: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
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
