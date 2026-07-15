import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ModelEvent, ModelGateway, ModelMessage, ModelRunContext } from "@lite-harness/provider-core";
import {
  JsonLineRpcClient,
  ProcessRpcError,
  runJsonLineProcess,
  type ProcessSpec,
  type RpcNotification,
  type RpcServerRequest,
} from "@lite-harness/process-rpc";

export interface DelegatedApprovalRequest {
  method: string;
  params?: unknown;
}

export interface CodexAppServerOptions {
  command?: string;
  workspacePathForRun: (context: ModelRunContext) => string;
  codexHome?: string;
  model?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  timeoutMs?: number;
  processFactory?: (
    handler: (request: RpcServerRequest) => Promise<unknown>,
    spec: ProcessSpec,
  ) => JsonLineRpcClient;
  approve?: (request: DelegatedApprovalRequest) => Promise<"accept" | "decline">;
}

/** Official Codex app-server adapter over its stable stdio JSONL protocol. */
export class CodexAppServerGateway implements ModelGateway {
  constructor(private readonly options: CodexAppServerOptions) {}

  async *streamTurn(params: {
    messages: readonly ModelMessage[];
    context?: ModelRunContext;
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent> {
    if (params.context?.maxCostUsd !== undefined && !hasDelegatedPricing(this.options)) {
      throw new DelegatedRuntimeError(
        "unknown_model_price",
        "Codex delegated pricing is required by the run cost ceiling",
      );
    }
    const cwd = workspacePathForRun(this.options.workspacePathForRun, params.context);
    const processSpec: ProcessSpec = {
      command: this.options.command ?? "codex",
      args: ["app-server", "--listen", "stdio://"],
      cwd,
      ...(this.options.codexHome ? { env: { CODEX_HOME: this.options.codexHome } } : {}),
    };
    const handler = (request: RpcServerRequest) => this.#answerRequest(request);
    const rpc = this.options.processFactory?.(handler, processSpec) ?? new JsonLineRpcClient(
      processSpec,
      {
        requestTimeoutMs: this.options.timeoutMs ?? 30_000,
        onServerRequest: handler,
      },
    );
    const notifications = new AsyncQueue<RpcNotification>();
    const unsubscribe = rpc.onNotification((notification) => notifications.push(notification));
    let threadId: string | undefined;
    let turnId: string | undefined;
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "lite_harness", title: "Lite-Harness", version: "0.1.0-alpha.0" },
      }, { signal: params.signal });
      rpc.notify("initialized", {});
      const thread = await rpc.request<{ thread?: { id?: string } }>(
        "thread/start",
        {
          ...(this.options.model ? { model: this.options.model } : {}),
          cwd,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          ephemeral: true,
        },
        { signal: params.signal },
      );
      threadId = thread.thread?.id;
      if (!threadId) throw new DelegatedRuntimeError("protocol_error", "Codex app-server did not return a thread id");
      const turn = await rpc.request<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        cwd,
        input: [{ type: "text", text: renderTranscript(params.messages) }],
      }, { signal: params.signal });
      turnId = turn.turn?.id;

      let emittedText = false;
      while (true) {
        const notification = await notifications.take(params.signal);
        if (notification.method === "item/agentMessage/delta") {
          const delta = stringAt(notification.params, "delta") ?? stringAt(notification.params, "text");
          if (delta) {
            emittedText = true;
            yield { type: "text.delta", delta };
          }
        } else if (notification.method === "item/completed" && !emittedText) {
          const text = agentMessageText(notification.params);
          if (text) {
            emittedText = true;
            yield { type: "text.delta", delta: text };
          }
        } else if (/tokenUsage|usage/i.test(notification.method)) {
          const usage = normalizeUsage(notification.params);
          if (usage) yield withDelegatedCost(usage, this.options);
        } else if (notification.method === "turn/completed") {
          const status = stringAt(notification.params, "turn", "status") ?? stringAt(notification.params, "status") ?? "completed";
          if (!["completed", "success", "succeeded"].includes(status)) {
            throw new DelegatedRuntimeError("delegated_turn_failed", `Codex delegated turn ended with status ${status}`);
          }
          yield { type: "completed", finishReason: "stop" };
          return;
        }
      }
    } catch (error) {
      if (params.signal?.aborted && threadId && turnId) {
        try { await rpc.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 2_000 }); } catch { /* best effort */ }
      }
      throw normalizeDelegatedError("codex", error);
    } finally {
      unsubscribe();
      notifications.close();
      await rpc.stop();
    }
  }

  async #answerRequest(request: RpcServerRequest): Promise<unknown> {
    if (/requestApproval$/i.test(request.method)) {
      const decision = await this.options.approve?.({ method: request.method, params: request.params }) ?? "decline";
      return { decision };
    }
    throw new DelegatedRuntimeError("server_request_denied", `Codex server request is not brokered: ${request.method}`);
  }
}

export interface ClaudeCodeOptions {
  command?: string;
  commandArgsPrefix?: readonly string[];
  workspacePathForRun: (context: ModelRunContext) => string;
  model?: string;
  allowedTools?: readonly string[];
  maxBudgetUsd?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
  processRunner?: typeof runJsonLineProcess;
}

/** Optional official Claude Code CLI adapter using print-mode stream-json. */
export class ClaudeCodeGateway implements ModelGateway {
  constructor(private readonly options: ClaudeCodeOptions) {}

  async *streamTurn(params: {
    messages: readonly ModelMessage[];
    context?: ModelRunContext;
    signal?: AbortSignal;
  }): AsyncIterable<ModelEvent> {
    const cwd = workspacePathForRun(this.options.workspacePathForRun, params.context);
    const queue = new AsyncQueue<ModelEvent>();
    let sawDelta = false;
    let sawUsage = false;
    const effectiveBudgetUsd = minimumDefined(this.options.maxBudgetUsd, params.context?.maxCostUsd);
    const args = [
      ...(this.options.commandArgsPrefix ?? []),
      "--print",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
      "--tools", this.options.allowedTools?.join(",") ?? "",
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(effectiveBudgetUsd !== undefined ? ["--max-budget-usd", String(effectiveBudgetUsd)] : []),
    ];
    const claudePromptStdin = renderTranscript(params.messages);
    const execution = (this.options.processRunner ?? runJsonLineProcess)(
      {
        command: this.options.command ?? "claude",
        args,
        cwd,
        ...(this.options.env ? { env: this.options.env } : {}),
      },
      {
        signal: params.signal,
        input: claudePromptStdin,
        timeoutMs: this.options.timeoutMs,
        onMessage: (message) => {
          const event = message as Record<string, unknown>;
          const delta = claudeDelta(event);
          if (delta) {
            sawDelta = true;
            queue.push({ type: "text.delta", delta });
          }
          if (event.type === "result") {
            if (!sawDelta && typeof event.result === "string" && event.result) {
              queue.push({ type: "text.delta", delta: event.result });
            }
            const usage = normalizeUsage(event.usage, numberAt(event, "total_cost_usd"));
            if (usage) {
              sawUsage = true;
              queue.push(withDelegatedCost(usage, this.options));
            }
            if (event.is_error === true) {
              queue.fail(new DelegatedRuntimeError("delegated_turn_failed", String(event.result ?? "Claude delegated turn failed")));
            }
          }
        },
      },
    ).then(
      () => {
        if (!sawUsage) {
          if (params.context?.maxCostUsd !== undefined) {
            queue.fail(new DelegatedRuntimeError(
              "unknown_model_price",
              "Claude delegated run completed without enforceable cost usage",
            ));
            return;
          }
          queue.push({ type: "usage", inputTokens: 0, outputTokens: 0 });
        }
        queue.push({ type: "completed", finishReason: "stop" });
        queue.close();
      },
      (error) => queue.fail(normalizeDelegatedError("claude", error)),
    );
    try {
      while (true) {
        const event = await queue.take(params.signal);
        yield event;
        if (event.type === "completed") return;
      }
    } finally {
      await execution.catch(() => undefined);
    }
  }
}

function workspacePathForRun(
  resolvePath: (context: ModelRunContext) => string,
  context: ModelRunContext | undefined,
): string {
  if (!context) {
    throw new DelegatedRuntimeError("workspace_context_missing", "Delegated runtime requires an owned leased workspace context");
  }
  const configured = resolvePath(context);
  if (!isAbsolute(configured)) {
    throw new DelegatedRuntimeError("workspace_path_invalid", "Delegated workspace path must be absolute");
  }
  const path = realpathSync(configured);
  if (!statSync(path).isDirectory()) {
    throw new DelegatedRuntimeError("workspace_path_invalid", "Delegated workspace path is not a directory");
  }
  return path;
}

export class DelegatedRuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly provider?: string) {
    super(message);
    this.name = "DelegatedRuntimeError";
  }
}

function renderTranscript(messages: readonly ModelMessage[]): string {
  if (messages.some((message) => message.imageDataUrls?.length)) {
    throw new DelegatedRuntimeError("unsupported_capability", "Delegated text runtimes cannot receive image context");
  }
  return messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
}

function normalizeDelegatedError(provider: string, error: unknown): Error {
  if (error instanceof DelegatedRuntimeError) return error;
  if (error instanceof ProcessRpcError) return new DelegatedRuntimeError(error.code, error.message, provider);
  return new DelegatedRuntimeError("delegated_runtime_failed", error instanceof Error ? error.message : String(error), provider);
}

function agentMessageText(value: unknown): string | undefined {
  return stringAt(value, "item", "text") ?? stringAt(value, "item", "content") ?? stringAt(value, "text");
}

function claudeDelta(event: Record<string, unknown>): string | undefined {
  if (event.type !== "stream_event") return undefined;
  return stringAt(event, "event", "delta", "text");
}

function normalizeUsage(value: unknown, costUsd?: number): Extract<ModelEvent, { type: "usage" }> | undefined {
  const inputTokens = numberAt(value, "input_tokens") ?? numberAt(value, "inputTokens") ??
    numberAt(value, "tokenUsage", "last", "inputTokens") ?? numberAt(value, "total", "inputTokens");
  const outputTokens = numberAt(value, "output_tokens") ?? numberAt(value, "outputTokens") ??
    numberAt(value, "tokenUsage", "last", "outputTokens") ?? numberAt(value, "total", "outputTokens");
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return undefined;
  return {
    type: "usage",
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function hasDelegatedPricing(options: {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}): boolean {
  return options.inputUsdPerMillion !== undefined && Number.isFinite(options.inputUsdPerMillion) &&
    options.inputUsdPerMillion >= 0 && options.outputUsdPerMillion !== undefined &&
    Number.isFinite(options.outputUsdPerMillion) && options.outputUsdPerMillion >= 0;
}

function withDelegatedCost(
  usage: Extract<ModelEvent, { type: "usage" }>,
  options: { inputUsdPerMillion?: number; outputUsdPerMillion?: number },
): Extract<ModelEvent, { type: "usage" }> {
  if (!hasDelegatedPricing(options)) return usage;
  const calculated = (
    usage.inputTokens * (options.inputUsdPerMillion as number) +
    usage.outputTokens * (options.outputUsdPerMillion as number)
  ) / 1_000_000;
  return { ...usage, costUsd: Math.max(usage.costUsd ?? 0, calculated) };
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function numberAt(value: unknown, ...path: string[]): number | undefined {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" && Number.isFinite(current) && current >= 0 ? current : undefined;
}

class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{ resolve(value: T): void; reject(error: Error): void }> = [];
  #error: Error | undefined;
  #closed = false;

  push(value: T): void {
    if (this.#closed || this.#error) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.#values.push(value);
  }

  fail(error: Error): void {
    if (this.#closed || this.#error) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new DelegatedRuntimeError("stream_closed", "Delegated runtime stream closed"));
  }

  async take(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const value = this.#values.shift();
    if (value !== undefined) return value;
    if (this.#error) throw this.#error;
    if (this.#closed) throw new DelegatedRuntimeError("stream_closed", "Delegated runtime stream closed");
    return await new Promise<T>((resolve, reject) => {
      let waiter: { resolve(value: T): void; reject(error: Error): void };
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Delegated runtime aborted"));
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      waiter = {
        resolve: (item) => { signal?.removeEventListener("abort", abort); resolve(item); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      };
      this.#waiters.push(waiter);
    });
  }
}

export function createDelegatedSessionId(): string {
  return randomUUID();
}
