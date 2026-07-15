import { createHash, randomUUID } from "node:crypto";
import type { InternalPrincipal, ToolCall, ToolDefinition } from "@lite-harness/contracts";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export type ModelEvent =
  | { type: "text.delta"; delta: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "completed"; finishReason: "stop" | "tool_calls" };

export type ProviderAdapterEvent = ModelEvent | { type: "request.accepted" };

export interface ModelRunContext {
  runId: string;
  attemptId: string;
  workspaceId: string;
  principal: InternalPrincipal;
  fencingToken: number;
  maxCostUsd?: number;
}

export interface ModelGateway {
  streamTurn(params: {
    messages: readonly ModelMessage[];
    tools?: readonly ToolDefinition[];
    context?: ModelRunContext;
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent>;
}

export type ModelCapability =
  | "text"
  | "tools"
  | "vision"
  | "json"
  | "reasoning"
  | "delegated-agent";

export interface ModelDescriptor {
  id: string;
  providerId: string;
  transport: "direct" | "delegated";
  credentialProfileId: string;
  capabilities: readonly ModelCapability[];
  contextWindow: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  provenance: "static" | "discovered" | "operator";
  enabled: boolean;
}

export interface RouteRequest {
  requiredCapabilities: readonly ModelCapability[];
  allowedProviders?: readonly string[];
  allowedModels?: readonly string[];
  preferredModel?: string;
  maxInputUsdPerMillion?: number;
}

export interface RoutePlan {
  id: string;
  registryGeneration: number;
  selected: ModelDescriptor;
  fallbacks: readonly ModelDescriptor[];
  createdAt: string;
}

export class ModelRegistry {
  readonly #models = new Map<string, ModelDescriptor>();
  #generation = 1;

  constructor(models: readonly ModelDescriptor[] = []) {
    for (const model of models) this.register(model);
  }

  get generation(): number {
    return this.#generation;
  }

  register(model: ModelDescriptor): void {
    validateModel(model);
    this.#models.set(model.id, Object.freeze({ ...model, capabilities: [...model.capabilities] }));
    this.#generation += 1;
  }

  get(modelId: string): ModelDescriptor | undefined {
    return this.#models.get(modelId);
  }

  list(): ModelDescriptor[] {
    return [...this.#models.values()];
  }

  plan(request: RouteRequest): RoutePlan {
    let unknownModelPrice = false;
    const candidates = this.list().filter((model) => {
      if (!model.enabled) return false;
      if (!request.requiredCapabilities.every((capability) => model.capabilities.includes(capability))) return false;
      if (request.allowedProviders && !request.allowedProviders.includes(model.providerId)) return false;
      if (request.allowedModels && !request.allowedModels.includes(model.id)) return false;
      if (request.maxInputUsdPerMillion !== undefined) {
        if (model.inputUsdPerMillion === undefined) {
          unknownModelPrice = true;
          return false;
        }
        if (model.inputUsdPerMillion > request.maxInputUsdPerMillion) return false;
      }
      return true;
    });
    candidates.sort((left, right) => score(left, request) - score(right, request));
    const selected = candidates[0];
    if (!selected) {
      if (unknownModelPrice) {
        throw new ProviderError(
          "unknown_model_price",
          "A compatible model has unknown pricing under the requested cost ceiling",
          false,
        );
      }
      throw new ProviderError("no_compatible_model", "No enabled model satisfies the required capabilities and policy", false);
    }
    return Object.freeze({
      id: `route_${randomUUID().replaceAll("-", "")}`,
      registryGeneration: this.#generation,
      selected,
      fallbacks: Object.freeze(candidates.slice(1)),
      createdAt: new Date().toISOString(),
    });
  }
}

export interface CredentialMaterial {
  authorizationHeader: string;
  expiresAt?: string;
}

export interface CredentialBroker {
  resolve(profileId: string, signal?: AbortSignal): Promise<CredentialMaterial>;
}

export interface RefreshingCredentialSource {
  load(profileId: string, signal?: AbortSignal): Promise<CredentialMaterial | undefined>;
  refresh(profileId: string, current: CredentialMaterial | undefined, signal?: AbortSignal): Promise<CredentialMaterial>;
}

export class SingleFlightCredentialBroker implements CredentialBroker {
  readonly #cache = new Map<string, CredentialMaterial>();
  readonly #refreshes = new Map<string, Promise<CredentialMaterial>>();

  constructor(private readonly source: RefreshingCredentialSource, private readonly refreshSkewMs = 60_000) {}

  async resolve(profileId: string, signal?: AbortSignal): Promise<CredentialMaterial> {
    if (!profileId.trim()) throw new ProviderError("credential_missing", "Credential profile id is required", false);
    signal?.throwIfAborted();
    const current = this.#cache.get(profileId) ?? await this.source.load(profileId, signal);
    if (current && !expiresSoon(current, this.refreshSkewMs)) {
      this.#cache.set(profileId, { ...current });
      return { ...current };
    }
    let refresh = this.#refreshes.get(profileId);
    if (!refresh) {
      refresh = this.source.refresh(profileId, current, signal).then((material) => {
        if (!material.authorizationHeader.trim() || expiresSoon(material, 0)) {
          throw new ProviderError("credential_expired", `Credential refresh failed for profile: ${profileId}`, true);
        }
        this.#cache.set(profileId, { ...material });
        return { ...material };
      }).finally(() => this.#refreshes.delete(profileId));
      this.#refreshes.set(profileId, refresh);
    }
    return { ...await refresh };
  }

  revoke(profileId: string): void {
    this.#cache.delete(profileId);
  }
}

export class InMemoryCredentialBroker implements CredentialBroker {
  readonly #profiles = new Map<string, CredentialMaterial>();

  set(profileId: string, material: CredentialMaterial): void {
    if (!profileId.trim() || !material.authorizationHeader.trim()) {
      throw new Error("Credential profile and authorization header are required");
    }
    this.#profiles.set(profileId, { ...material });
  }

  async resolve(profileId: string): Promise<CredentialMaterial> {
    const material = this.#profiles.get(profileId);
    if (!material) throw new ProviderError("credential_missing", `Credential profile is unavailable: ${profileId}`, false);
    if (material.expiresAt && material.expiresAt <= new Date().toISOString()) {
      throw new ProviderError("credential_expired", `Credential profile expired: ${profileId}`, true);
    }
    return { ...material };
  }
}

export interface ProviderAdapter {
  readonly providerId: string;
  stream(params: {
    model: ModelDescriptor;
    messages: readonly ModelMessage[];
    tools?: readonly ToolDefinition[];
    credential: CredentialMaterial;
    signal?: AbortSignal;
  }): AsyncIterable<ProviderAdapterEvent>;
}

export async function* readSseData(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
  maxBufferBytes = 2 * 1024 * 1024,
): AsyncIterable<string> {
  if (!body) throw new ProviderError("invalid_response", "Provider response body is missing", false);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
      if (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
        throw new ProviderError("response_too_large", "Provider SSE frame exceeded the buffer limit", false);
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        if (buffer.trim()) {
          const data = buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data) yield data;
        }
        completed = true;
        return;
      }
    }
  } finally {
    if (!completed) await reader.cancel("provider stream closed").catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readProviderJson(response: Response, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("invalid_response", "Provider response body is missing", false);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel("provider response limit exceeded");
        throw new ProviderError("response_too_large", "Provider response exceeded the size limit", false);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new ProviderError("invalid_response", "Provider returned invalid JSON", false); }
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class RoutedModelGateway implements ModelGateway {
  readonly #adapters = new Map<string, ProviderAdapter>();

  constructor(
    private readonly plan: RoutePlan,
    adapters: readonly ProviderAdapter[],
    private readonly credentials: CredentialBroker,
  ) {
    for (const adapter of adapters) this.#adapters.set(adapter.providerId, adapter);
  }

  async *streamTurn(params: {
    messages: readonly ModelMessage[];
    tools?: readonly ToolDefinition[];
    context?: ModelRunContext;
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent> {
    const routes = [this.plan.selected, ...this.plan.fallbacks];
    let lastError: unknown;
    let externallyVisible = false;

    for (const model of routes) {
      if (params.context?.maxCostUsd !== undefined && !hasKnownModelPricing(model)) {
        lastError = new ProviderError(
          "unknown_model_price",
          `Model pricing is required by the run cost ceiling: ${model.id}`,
          false,
        );
        continue;
      }
      const adapter = this.#adapters.get(model.providerId);
      if (!adapter) {
        lastError = new ProviderError("adapter_missing", `Provider adapter is unavailable: ${model.providerId}`, false);
        continue;
      }
      try {
        const credential = await this.credentials.resolve(model.credentialProfileId, params.signal);
        for await (const event of adapter.stream({
          model,
          messages: params.messages,
          ...(params.tools?.length ? { tools: params.tools } : {}),
          credential,
          ...(params.signal ? { signal: params.signal } : {}),
        })) {
          if (providerRequestBecameVisible(event)) externallyVisible = true;
          if (event.type === "request.accepted") continue;
          yield event.type === "usage" ? withAuthoritativeCost(event, model) : event;
        }
        return;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderError && error.retryable;
        if (!retryable || externallyVisible) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError("route_exhausted", "Every provider route failed", true);
  }
}

/** Once true, retrying another route could duplicate billed or externally visible work. */
export function providerRequestBecameVisible(event: ProviderAdapterEvent): boolean {
  return event.type === "request.accepted" || event.type === "usage" ||
    event.type === "tool.call" || event.type === "text.delta";
}

export interface UsageRecord {
  runId: string;
  routePlanId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordedAt: string;
}

export class UsageLedger {
  readonly #records: UsageRecord[] = [];

  record(record: Omit<UsageRecord, "recordedAt">): UsageRecord {
    const stored = { ...record, recordedAt: new Date().toISOString() };
    this.#records.push(stored);
    return stored;
  }

  list(runId?: string): UsageRecord[] {
    return this.#records.filter((record) => !runId || record.runId === runId).map((record) => ({ ...record }));
  }
}

export function redactProviderData(value: unknown, extraSecrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    let redacted = value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi, "Bearer [REDACTED]")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
    for (const secret of extraSecrets.filter((item) => item.length >= 8)) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactProviderData(item, extraSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /authorization|api[-_]?key|token|secret/i.test(key)
          ? "[REDACTED]"
          : redactProviderData(item, extraSecrets),
      ]),
    );
  }
  return value;
}

export function requestFingerprint(messages: readonly ModelMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function validateModel(model: ModelDescriptor): void {
  if (!model.id || !model.providerId || !model.credentialProfileId) throw new Error("Model identity fields are required");
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) throw new Error("Model contextWindow must be positive");
  if (!model.capabilities.includes("text")) throw new Error("Every Lite model must declare text capability");
  if ((model.inputUsdPerMillion === undefined) !== (model.outputUsdPerMillion === undefined)) {
    throw new Error("Model pricing must provide both input and output rates or neither");
  }
  for (const [name, value] of [
    ["inputUsdPerMillion", model.inputUsdPerMillion],
    ["outputUsdPerMillion", model.outputUsdPerMillion],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Model ${name} must be a finite non-negative number`);
    }
  }
}

function hasKnownModelPricing(model: ModelDescriptor): boolean {
  return model.inputUsdPerMillion !== undefined && model.outputUsdPerMillion !== undefined;
}

function withAuthoritativeCost(
  event: Extract<ModelEvent, { type: "usage" }>,
  model: ModelDescriptor,
): Extract<ModelEvent, { type: "usage" }> {
  if (!Number.isFinite(event.inputTokens) || event.inputTokens < 0 ||
      !Number.isFinite(event.outputTokens) || event.outputTokens < 0) {
    throw new ProviderError("invalid_usage", "Provider returned invalid token usage", false);
  }
  const reported = event.costUsd;
  if (reported !== undefined && (!Number.isFinite(reported) || reported < 0)) {
    throw new ProviderError("invalid_usage", "Provider returned invalid cost usage", false);
  }
  if (!hasKnownModelPricing(model)) return event;
  const calculated = (
    event.inputTokens * (model.inputUsdPerMillion as number) +
    event.outputTokens * (model.outputUsdPerMillion as number)
  ) / 1_000_000;
  return { ...event, costUsd: Math.max(reported ?? 0, calculated) };
}

function expiresSoon(material: CredentialMaterial, skewMs: number): boolean {
  if (!material.expiresAt) return false;
  const expiresAt = Date.parse(material.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + skewMs;
}

function score(model: ModelDescriptor, request: RouteRequest): number {
  const preferredPenalty = request.preferredModel === model.id ? -1_000_000 : 0;
  const transportPenalty = model.transport === "delegated" ? 10_000 : 0;
  return preferredPenalty + transportPenalty + (model.inputUsdPerMillion ?? 1_000) + (model.outputUsdPerMillion ?? 1_000);
}
