import { createHash, randomUUID } from "node:crypto";
import type { ToolCall } from "@lite-harness/contracts";

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export type ModelEvent =
  | { type: "text.delta"; delta: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "completed"; finishReason: "stop" | "tool_calls" };

export interface ModelGateway {
  streamTurn(params: {
    messages: readonly ModelMessage[];
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
    const candidates = this.list().filter((model) => {
      if (!model.enabled) return false;
      if (!request.requiredCapabilities.every((capability) => model.capabilities.includes(capability))) return false;
      if (request.allowedProviders && !request.allowedProviders.includes(model.providerId)) return false;
      if (request.allowedModels && !request.allowedModels.includes(model.id)) return false;
      if (
        request.maxInputUsdPerMillion !== undefined &&
        model.inputUsdPerMillion !== undefined &&
        model.inputUsdPerMillion > request.maxInputUsdPerMillion
      ) return false;
      return true;
    });
    candidates.sort((left, right) => score(left, request) - score(right, request));
    const selected = candidates[0];
    if (!selected) {
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
    credential: CredentialMaterial;
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent>;
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
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent> {
    const routes = [this.plan.selected, ...this.plan.fallbacks];
    let lastError: unknown;
    let externallyVisible = false;

    for (const model of routes) {
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
          credential,
          ...(params.signal ? { signal: params.signal } : {}),
        })) {
          if (event.type === "tool.call") externallyVisible = true;
          yield event;
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
}

function score(model: ModelDescriptor, request: RouteRequest): number {
  const preferredPenalty = request.preferredModel === model.id ? -1_000_000 : 0;
  const transportPenalty = model.transport === "delegated" ? 10_000 : 0;
  return preferredPenalty + transportPenalty + (model.inputUsdPerMillion ?? 1_000) + (model.outputUsdPerMillion ?? 1_000);
}
