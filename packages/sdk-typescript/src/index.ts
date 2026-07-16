import { randomUUID } from "node:crypto";
import { isTerminalRunStatus } from "@lite-harness/contracts";
import { GENERATED_API_OPERATIONS } from "./generated-api.js";
import type {
  CreateRunRequest,
  ArtifactPayloadResponse,
  ArtifactRecord,
  ApprovalRecord,
  AgentProfileRecord,
  WorkspaceRecord,
  RunAttemptRecord,
  CreateAgentProfileRequest,
  CreateWorkspaceRequest,
  CreateRunResponse,
  RunEvent,
  RunRecord,
  SessionMessageRecord,
  SessionRecord,
  PublishArtifactRequest,
  ErrorEnvelope,
  MintRunTokenRequest,
  MintRunTokenResponse,
  RevokeTokenResponse,
} from "@lite-harness/contracts";
export * from "./generated-api.js";

export interface LiteHarnessClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface RunEventStreamOptions {
  signal?: AbortSignal;
  reconnectDelayMs?: number;
}

export class LiteHarnessError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code = "request_failed",
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LiteHarnessError";
  }
}

export class LiteHarnessClient {
  readonly #fetch: typeof globalThis.fetch;

  constructor(private readonly options: LiteHarnessClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async createRun(request: CreateRunRequest, idempotencyKey = randomUUID()): Promise<CreateRunResponse> {
    return this.#jsonMethod<CreateRunResponse>("createRun", {
      init: {
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(request),
      },
    });
  }

  mintRunToken(request: MintRunTokenRequest): Promise<MintRunTokenResponse> {
    return this.#jsonMethod<MintRunTokenResponse>("mintRunToken", {
      init: { headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
    });
  }

  revokeToken(tokenId: string): Promise<RevokeTokenResponse> {
    return this.#jsonMethod<RevokeTokenResponse>("revokeToken", { pathParams: { tokenId } });
  }

  getRun(runId: string): Promise<RunRecord> {
    return this.#jsonMethod<RunRecord>("getRun", { pathParams: { runId } });
  }

  cancelRun(runId: string): Promise<RunRecord> {
    return this.#jsonMethod<RunRecord>("cancelRun", { pathParams: { runId } });
  }

  async getRunAttempts(runId: string): Promise<RunAttemptRecord[]> {
    return (await this.#jsonMethod<{ attempts: RunAttemptRecord[] }>("getRunAttempts", { pathParams: { runId } })).attempts;
  }

  async getChildRuns(runId: string): Promise<RunRecord[]> {
    return (await this.#jsonMethod<{ runs: RunRecord[] }>("getChildRuns", { pathParams: { runId } })).runs;
  }

  steerRun(runId: string, instruction: string): Promise<RunRecord> {
    return this.#jsonMethod<RunRecord>("steerRun", {
      pathParams: { runId },
      init: { headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }) },
    });
  }

  resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalRecord> {
    return this.#jsonMethod<ApprovalRecord>("resolveApproval", {
      pathParams: { approvalId },
      init: { headers: { "content-type": "application/json" }, body: JSON.stringify({ approved }) },
    });
  }

  getSession(sessionId: string): Promise<SessionRecord> {
    return this.#jsonMethod<SessionRecord>("getSession", { pathParams: { sessionId } });
  }

  async getSessionMessages(sessionId: string): Promise<SessionMessageRecord[]> {
    const response = await this.#jsonMethod<{ messages: SessionMessageRecord[] }>("getSessionMessages", { pathParams: { sessionId } });
    return response.messages;
  }

  publishArtifact(runId: string, request: PublishArtifactRequest): Promise<ArtifactRecord> {
    return this.#jsonMethod<ArtifactRecord>("publishArtifact", {
      pathParams: { runId },
      init: { headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
    });
  }

  async downloadArtifact(artifactId: string): Promise<{ record: ArtifactRecord; data: Uint8Array }> {
    const payload = await this.#jsonMethod<ArtifactPayloadResponse>("downloadArtifact", { pathParams: { artifactId } });
    return { record: payload.record, data: Uint8Array.from(Buffer.from(payload.dataBase64, "base64")) };
  }

  createAgent(request: CreateAgentProfileRequest): Promise<AgentProfileRecord> {
    return this.#jsonMethod<AgentProfileRecord>("createAgent", {
      init: { headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
    });
  }

  getAgent(agentId: string): Promise<AgentProfileRecord> {
    return this.#jsonMethod<AgentProfileRecord>("getAgent", { pathParams: { agentId } });
  }

  async listAgents(): Promise<AgentProfileRecord[]> {
    return (await this.#jsonMethod<{ agents: AgentProfileRecord[] }>("listAgents")).agents;
  }

  createWorkspace(request: CreateWorkspaceRequest = {}): Promise<WorkspaceRecord> {
    return this.#jsonMethod<WorkspaceRecord>("createWorkspace", {
      init: { headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
    });
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    return this.#jsonMethod<WorkspaceRecord>("getWorkspace", { pathParams: { workspaceId } });
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return (await this.#jsonMethod<{ workspaces: WorkspaceRecord[] }>("listWorkspaces")).workspaces;
  }

  async *events(runId: string, after = 0, options: RunEventStreamOptions = {}): AsyncIterable<RunEvent> {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new LiteHarnessError("Event cursor must be a non-negative safe integer", undefined, "invalid_event_cursor");
    }
    const reconnectDelayMs = options.reconnectDelayMs ?? 250;
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0 || reconnectDelayMs > 60_000) {
      throw new LiteHarnessError("Reconnect delay must be between 0 and 60000 milliseconds", undefined, "invalid_reconnect_delay");
    }

    let cursor = after;
    while (true) {
      throwIfAborted(options.signal);
      try {
        const operation = operationRouteForMethod("events", { runId });
        const response = await this.#fetch(
          this.#url(`${operation.path}?after=${cursor}`),
          { method: operation.method, headers: this.#headers(), signal: options.signal },
        );
        if (!response.ok || !response.body) {
          throw new LiteHarnessError(
            `Event stream failed with HTTP ${response.status}`,
            response.status,
            "event_stream_failed",
            response.status >= 500,
          );
        }

        for await (const event of readEventStream(response.body)) {
          if (event.runId !== runId) {
            throw new LiteHarnessError("Event stream returned a different run", undefined, "event_stream_run_mismatch");
          }
          if (event.sequence <= cursor) continue;
          if (event.sequence !== cursor + 1) {
            throw new LiteHarnessError(
              `Event stream sequence gap: expected ${cursor + 1}, received ${event.sequence}`,
              undefined,
              "event_sequence_gap",
            );
          }
          cursor = event.sequence;
          yield event;
        }

        const run = await this.#jsonMethod<RunRecord>("getRun", { pathParams: { runId }, init: { signal: options.signal } });
        if (isTerminalRunStatus(run.status) && cursor >= run.lastSequence) return;
      } catch (error) {
        throwIfAborted(options.signal);
        if (!isRetryableEventStreamError(error)) throw error;
      }
      await abortableDelay(reconnectDelayMs, options.signal);
    }
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(this.#url(path), {
      ...init,
      headers: { ...this.#headers(), ...(init.headers ?? {}) },
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const envelope = parseErrorEnvelope(body);
      throw envelope
        ? new LiteHarnessError(
          envelope.error.message,
          response.status,
          envelope.error.code,
          envelope.error.retryable,
          envelope.error.retryAfterMs,
          envelope.error.details,
        )
        : new LiteHarnessError(`Lite-Harness request failed with HTTP ${response.status}`, response.status, "invalid_error_response");
    }
    return body as T;
  }

  #jsonMethod<T>(
    methodName: AuthenticatedClientMethod,
    options: { pathParams?: Readonly<Record<string, string>>; init?: RequestInit } = {},
  ): Promise<T> {
    const operation = operationRouteForMethod(methodName, options.pathParams);
    return this.#json<T>(operation.path, { ...options.init, method: operation.method });
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}` };
  }

  #url(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }
}

type AuthenticatedApiOperation = Extract<
  (typeof GENERATED_API_OPERATIONS)[number],
  { path: `/v1/${string}` }
>;
export type AuthenticatedOperationId = AuthenticatedApiOperation["operationId"];

/**
 * The generated OpenAPI inventory is authoritative. Every authenticated /v1
 * operation must map to exactly one public client method.
 */
export const AUTHENTICATED_OPERATION_METHODS = {
  getV1Agents: "listAgents",
  postV1Agents: "createAgent",
  getV1AgentsByAgentId: "getAgent",
  postV1ApprovalsByApprovalId: "resolveApproval",
  getV1ArtifactsByArtifactId: "downloadArtifact",
  postV1Runs: "createRun",
  getV1RunsByRunId: "getRun",
  postV1RunsByRunIdArtifacts: "publishArtifact",
  getV1RunsByRunIdAttempts: "getRunAttempts",
  postV1RunsByRunIdCancel: "cancelRun",
  getV1RunsByRunIdChildren: "getChildRuns",
  getV1RunsByRunIdEvents: "events",
  postV1RunsByRunIdSteer: "steerRun",
  getV1SessionsBySessionId: "getSession",
  getV1SessionsBySessionIdMessages: "getSessionMessages",
  postV1Tokens: "mintRunToken",
  deleteV1TokensByTokenId: "revokeToken",
  getV1Workspaces: "listWorkspaces",
  postV1Workspaces: "createWorkspace",
  getV1WorkspacesByWorkspaceId: "getWorkspace",
} as const satisfies Record<AuthenticatedOperationId, keyof LiteHarnessClient>;

export const AUTHENTICATED_OPERATION_ROUTES = GENERATED_API_OPERATIONS
  .filter((operation): operation is AuthenticatedApiOperation => operation.path.startsWith("/v1/"))
  .map((operation) => [
    operation.method,
    operation.path,
    operation.operationId,
    AUTHENTICATED_OPERATION_METHODS[operation.operationId],
  ] as const);

export type AuthenticatedClientMethod = (typeof AUTHENTICATED_OPERATION_METHODS)[AuthenticatedOperationId];

const OPERATION_ROUTES_BY_METHOD = new Map<AuthenticatedClientMethod, { method: string; path: string }>(
  AUTHENTICATED_OPERATION_ROUTES.map(([method, path, _operationId, clientMethod]) => [clientMethod, { method, path }]),
);

if (OPERATION_ROUTES_BY_METHOD.size !== AUTHENTICATED_OPERATION_ROUTES.length) {
  throw new Error("TypeScript SDK maps more than one authenticated operation to the same client method");
}

for (const methodName of Object.values(AUTHENTICATED_OPERATION_METHODS)) {
  if (typeof LiteHarnessClient.prototype[methodName] !== "function") {
    throw new Error(`TypeScript SDK OpenAPI operation maps to missing client method: ${methodName}`);
  }
}

function operationRouteForMethod(
  methodName: AuthenticatedClientMethod,
  pathParams: Readonly<Record<string, string>> = {},
): { method: string; path: string } {
  const operation = OPERATION_ROUTES_BY_METHOD.get(methodName);
  if (!operation) throw new Error(`TypeScript SDK has no OpenAPI operation for client method: ${methodName}`);
  const required = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
  const missing = required.filter((name) => pathParams[name] === undefined);
  const unexpected = Object.keys(pathParams).filter((name) => !required.includes(name));
  if (missing.length) throw new Error(`Missing path parameters for ${methodName}: ${missing.join(", ")}`);
  if (unexpected.length) throw new Error(`Unexpected path parameters for ${methodName}: ${unexpected.join(", ")}`);
  return {
    method: operation.method,
    path: operation.path.replace(/\{([^}]+)\}/g, (_placeholder, name: string) => encodeURIComponent(pathParams[name] as string)),
  };
}

async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncIterable<RunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ? decoder.decode(value, { stream: !done }) : done ? decoder.decode() : "";
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary?.index !== undefined) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield parseEventFrame(data);
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) {
        complete = true;
        return;
      }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseEventFrame(data: string): RunEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new LiteHarnessError("Event stream returned invalid JSON", undefined, "invalid_event_stream_frame");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new LiteHarnessError("Event stream returned an invalid frame", undefined, "invalid_event_stream_frame");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.message === "string" && typeof record.runId !== "string") {
    throw new LiteHarnessError(record.message, undefined, "event_stream_error", true);
  }
  if (typeof record.runId !== "string" || !Number.isSafeInteger(record.sequence) ||
      (record.sequence as number) < 1 || typeof record.type !== "string" ||
      !record.payload || typeof record.payload !== "object" || typeof record.createdAt !== "string") {
    throw new LiteHarnessError("Event stream returned an invalid event", undefined, "invalid_event_stream_frame");
  }
  return record as unknown as RunEvent;
}

function isRetryableEventStreamError(error: unknown): boolean {
  if (!(error instanceof LiteHarnessError)) return true;
  if (error.code === "event_stream_error") return true;
  return error.retryable || (error.status !== undefined && error.status >= 500);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
    }
  });
}

function parseErrorEnvelope(value: unknown): ErrorEnvelope | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  return record.version === 1 && typeof record.code === "string" &&
    typeof record.message === "string" && typeof record.retryable === "boolean"
    ? value as ErrorEnvelope
    : undefined;
}

export type {
  CreateRunRequest,
  ArtifactPayloadResponse,
  ArtifactRecord,
  ApprovalRecord,
  AgentProfileRecord,
  WorkspaceRecord,
  RunAttemptRecord,
  CreateAgentProfileRequest,
  CreateWorkspaceRequest,
  CreateRunResponse,
  RunEvent,
  RunRecord,
  SessionMessageRecord,
  SessionRecord,
  PublishArtifactRequest,
  MintRunTokenRequest,
  MintRunTokenResponse,
  RevokeTokenResponse,
} from "@lite-harness/contracts";
