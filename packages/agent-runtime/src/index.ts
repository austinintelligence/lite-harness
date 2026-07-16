import type { InternalPrincipal, RunEventType, ToolCall, ToolDefinition, ToolResult } from "@lite-harness/contracts";
import { createId } from "@lite-harness/domain";
import { ProviderError, type ModelCapability, type ModelEvent, type ModelGateway, type ModelMessage } from "@lite-harness/provider-core";
import { authorizedWorkspaceArtifactPath, type ToolRuntime } from "@lite-harness/runtime";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";

const addFormats = addFormatsImport as unknown as FormatsPlugin;

export interface AgentRuntimeEvent {
  type: RunEventType;
  payload: Record<string, unknown>;
}

export interface AgentContextCompiler {
  compile(params: {
    input: string;
    instructions?: string;
    workspaceId: string;
    runId?: string;
    allowedTools?: readonly string[];
    principal?: InternalPrincipal;
    modelId?: string;
    modelCapabilities?: readonly ModelCapability[];
  }): Promise<readonly ModelMessage[]>;
  snapshotForRun?(params: { runId: string; principal: InternalPrincipal }): Promise<{ skills: Array<{ name: string; digest: string }> }>;
}

export interface AgentPreparedState {
  route?: { routePlanId: string; modelId: string; providerId: string; capabilities: readonly ModelCapability[] };
  tools: readonly ToolDefinition[];
  contextSnapshot: { skills: Array<{ name: string; digest: string }> };
}

export class AgentRunner {
  readonly #schemaCompiler: Ajv2020;
  readonly #validatorCache = new Map<string, { schemaJson: string; validate: ValidateFunction }>();

  constructor(
    private readonly model: ModelGateway,
    private readonly tools: ToolRuntime,
    private readonly maxTurns = 8,
    private readonly context?: AgentContextCompiler,
  ) {
    this.#schemaCompiler = new Ajv2020({
      allErrors: true,
      strict: true,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    });
    addFormats(this.#schemaCompiler);
    compileAdvertisedToolValidators(
      this.tools.listTools?.() ?? [],
      this.#schemaCompiler,
      this.#validatorCache,
    );
  }

  async run(params: {
    input: string;
    instructions?: string;
    allowedTools?: readonly string[];
    workspaceId: string;
    runId?: string;
    attemptId?: string;
    fencingToken?: number;
    maxCostUsd?: number;
    modelCapabilities?: readonly ModelCapability[];
    principal?: InternalPrincipal;
    history?: readonly ModelMessage[];
    takeSteering?: () => readonly ModelMessage[];
    beforeToolCall?: (call: ToolCall) => Promise<void | (() => void)>;
    onPrepared?: (state: AgentPreparedState) => Promise<void>;
    maxTurns?: number;
    modelIdleTimeoutMs?: number;
    commandTimeoutMs?: number;
    signal?: AbortSignal;
    onEvent: (event: AgentRuntimeEvent) => void;
  }): Promise<void> {
    const modelContext = params.runId && params.attemptId && params.principal && params.fencingToken !== undefined
      ? {
          runId: params.runId, attemptId: params.attemptId, workspaceId: params.workspaceId,
          principal: params.principal, fencingToken: params.fencingToken,
          ...(params.maxCostUsd !== undefined ? { maxCostUsd: params.maxCostUsd } : {}),
          requiredCapabilities: params.modelCapabilities?.length ? [...new Set(["text" as const, ...params.modelCapabilities])] : ["text" as const],
        }
      : undefined;
    const preparedRoute = modelContext ? await this.model.prepareRun?.(modelContext) : undefined;
    if (params.runId) {
      await this.tools.prepareRun?.({
        runId: params.runId,
        workspaceId: params.workspaceId,
        ...(params.attemptId ? { attemptId: params.attemptId } : {}),
        ...(params.allowedTools ? { allowedTools: Object.freeze([...params.allowedTools]) } : {}),
        ...(params.principal ? { principal: params.principal } : {}),
      });
    }
    const compiledContext = await this.context?.compile({
      input: params.input,
      ...(params.instructions ? { instructions: params.instructions } : {}),
      workspaceId: params.workspaceId,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.allowedTools ? { allowedTools: Object.freeze([...params.allowedTools]) } : {}),
      ...(params.principal ? { principal: params.principal } : {}),
      ...(preparedRoute ? { modelId: preparedRoute.modelId } : {}),
      ...(preparedRoute ? { modelCapabilities: preparedRoute.capabilities } : {}),
    }) ?? [];
    const messages: ModelMessage[] = [
      ...(params.instructions?.trim() ? [{ role: "system" as const, content: params.instructions.trim() }] : []),
      ...compiledContext.map((message) => ({ ...message })),
      ...(params.history?.length
        ? params.history.map((message) => ({ ...message }))
        : [{ role: "user" as const, content: params.input }]),
    ];
    const allowed = new Set(params.allowedTools ?? []);
    const advertisedTools = (this.tools.listTools?.({
      workspaceId: params.workspaceId,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.attemptId ? { attemptId: params.attemptId } : {}),
      allowedTools: Object.freeze([...allowed]),
      ...(params.principal ? { principal: params.principal } : {}),
    }) ?? []).filter((tool) => allowed.has(tool.name));
    const advertisedToolValidators = compileAdvertisedToolValidators(
      advertisedTools,
      this.#schemaCompiler,
      this.#validatorCache,
    );
    const contextSnapshot = params.runId && params.principal
      ? await this.context?.snapshotForRun?.({ runId: params.runId, principal: params.principal }) ?? { skills: [] }
      : { skills: [] };
    await params.onPrepared?.({
      ...(preparedRoute ? { route: preparedRoute } : {}),
      tools: Object.freeze(advertisedTools.map((tool) => Object.freeze({ ...tool, inputSchema: structuredClone(tool.inputSchema) }))),
      contextSnapshot,
    });

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
        ...(modelContext ? { context: modelContext } : {}),
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
            if (params.maxCostUsd !== undefined && event.costUsd === undefined) {
              throw new ProviderError(
                "unknown_model_price",
                "Model usage omitted cost while the run has an enforced cost ceiling",
                false,
              );
            }
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
        validateAdvertisedToolArguments(call, advertisedToolValidators);
        params.onEvent({
          type: "tool.call.requested",
          payload: { callId: call.id, name: call.name, arguments: call.arguments },
        });
        const assertAuthorized = await params.beforeToolCall?.(call);
        assertAuthorized?.();
        const commandSignal = params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(params.commandTimeoutMs ?? 300_000)])
          : AbortSignal.timeout(params.commandTimeoutMs ?? 300_000);
        const result = await this.tools.execute({
          workspaceId: params.workspaceId,
          ...(params.runId ? { runId: params.runId } : {}),
          ...(params.attemptId ? { attemptId: params.attemptId } : {}),
          ...(params.fencingToken !== undefined ? { fencingToken: params.fencingToken } : {}),
          allowedTools: Object.freeze([...allowed]),
          ...(params.principal ? { principal: params.principal } : {}),
          call,
          signal: commandSignal,
        });
        const artifactPayload = artifactCreatedPayload(call, result);
        params.onEvent({
          type: "tool.call.completed",
          payload: {
            callId: result.callId,
            ok: result.ok,
            content: result.content,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          },
        });
        if (artifactPayload) params.onEvent({ type: "artifact.created", payload: artifactPayload });
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

function artifactCreatedPayload(call: ToolCall, result: ToolResult): Record<string, unknown> | undefined {
  if (call.name !== "artifact_publish" || !result.ok) return undefined;
  const artifactId = result.metadata?.artifactId;
  const path = result.metadata?.path;
  const sha256 = result.metadata?.sha256;
  const sizeBytes = result.metadata?.sizeBytes;
  let validPath = false;
  if (typeof path === "string") {
    try {
      validPath = authorizedWorkspaceArtifactPath(path) === path;
    } catch {
      validPath = false;
    }
  }
  if (typeof artifactId !== "string" || !/^art_[a-f0-9]{32}$/.test(artifactId) || !validPath ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
      typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("artifact_publish returned invalid artifact metadata");
  }
  return { artifactId, path, sha256, sizeBytes };
}

export class ToolArgumentValidationError extends Error {
  readonly code: "tool_not_advertised" | "invalid_tool_arguments" | "invalid_tool_schema";

  constructor(
    code: ToolArgumentValidationError["code"],
    toolName: string,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${toolName}${detail ? ` (${detail})` : ""}`, options);
    this.name = "ToolArgumentValidationError";
    this.code = code;
  }
}

type AdvertisedToolValidators = ReadonlyMap<string, ValidateFunction>;

function compileAdvertisedToolValidators(
  tools: readonly import("@lite-harness/contracts").ToolDefinition[],
  ajv: Ajv2020,
  cache: Map<string, { schemaJson: string; validate: ValidateFunction }>,
): AdvertisedToolValidators {
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (validators.has(tool.name)) {
      throw new ToolArgumentValidationError("invalid_tool_schema", tool.name, "duplicate advertised name");
    }
    try {
      const schemaJson = JSON.stringify(tool.inputSchema);
      if (!schemaJson) throw new Error("schema is not JSON serializable");
      const cached = cache.get(tool.name);
      const validate = cached?.schemaJson === schemaJson ? cached.validate : ajv.compile(tool.inputSchema);
      cache.set(tool.name, { schemaJson, validate });
      validators.set(tool.name, validate);
    } catch (error) {
      throw new ToolArgumentValidationError("invalid_tool_schema", tool.name, "schema compilation failed", {
        cause: error,
      });
    }
  }
  return validators;
}

/** Enforces the exact immutable schema advertised to the model for this run. */
export function validateAdvertisedToolArguments(
  call: ToolCall,
  validators: AdvertisedToolValidators,
): void {
  const validate = validators.get(call.name);
  if (!validate) throw new ToolArgumentValidationError("tool_not_advertised", call.name);
  if (validate(call.arguments)) return;
  const violations = (validate.errors ?? [])
    .slice(0, 4)
    .map((error) => `${error.instancePath || "/"}:${error.keyword}`)
    .join(",");
  throw new ToolArgumentValidationError("invalid_tool_arguments", call.name, violations || "schema mismatch");
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
    const completedToolNames = new Set(params.messages.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.name) : []));
    const canPublishArtifact = params.tools?.some((tool) => tool.name === "artifact_publish") ?? false;

    if (!hasToolResult) {
      const writeFile = params.tools?.find((tool) => tool.name === "write_file");
      const soleTool = params.tools?.length === 1 ? params.tools[0] : undefined;
      if (!writeFile && soleTool) {
        const input = params.messages.findLast((message) => message.role === "user")?.content ?? "{}";
        let arguments_: Record<string, unknown>;
        try {
          const parsed = JSON.parse(input) as unknown;
          arguments_ = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : { value: parsed };
        } catch {
          arguments_ = { value: input };
        }
        yield { type: "text.delta", delta: `I will invoke ${soleTool.name}. ` };
        yield {
          type: "tool.call",
          call: { id: createId("tool"), name: soleTool.name, arguments: arguments_ },
        };
        yield { type: "usage", inputTokens: 12, outputTokens: 8, costUsd: 0 };
        yield { type: "completed", finishReason: "tool_calls" };
        return;
      }
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
      yield { type: "usage", inputTokens: 12, outputTokens: 8, costUsd: 0 };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    if (canPublishArtifact && completedToolNames.has("write_file") && !completedToolNames.has("artifact_publish")) {
      yield { type: "text.delta", delta: "I will publish the completed file. " };
      yield {
        type: "tool.call",
        call: {
          id: createId("tool"),
          name: "artifact_publish",
          arguments: { path: "hello.txt", mediaType: "text/plain" },
        },
      };
      yield { type: "usage", inputTokens: 18, outputTokens: 8, costUsd: 0 };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    yield { type: "text.delta", delta: "Created hello.txt successfully." };
    yield { type: "usage", inputTokens: 24, outputTokens: 6, costUsd: 0 };
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
