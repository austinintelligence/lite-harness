import { randomUUID } from "node:crypto";
import { isTerminalRunStatus } from "@lite-harness/contracts";
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
    return this.#json<CreateRunResponse>("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(request),
    });
  }

  mintRunToken(request: MintRunTokenRequest): Promise<MintRunTokenResponse> {
    return this.#json<MintRunTokenResponse>("/v1/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  revokeToken(tokenId: string): Promise<RevokeTokenResponse> {
    return this.#json<RevokeTokenResponse>(`/v1/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
  }

  getRun(runId: string): Promise<RunRecord> {
    return this.#json<RunRecord>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId: string): Promise<RunRecord> {
    return this.#json<RunRecord>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }

  async getRunAttempts(runId: string): Promise<RunAttemptRecord[]> {
    return (await this.#json<{ attempts: RunAttemptRecord[] }>(
      `/v1/runs/${encodeURIComponent(runId)}/attempts`,
    )).attempts;
  }

  async getChildRuns(runId: string): Promise<RunRecord[]> {
    return (await this.#json<{ runs: RunRecord[] }>(
      `/v1/runs/${encodeURIComponent(runId)}/children`,
    )).runs;
  }

  steerRun(runId: string, instruction: string): Promise<RunRecord> {
    return this.#json<RunRecord>(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction }),
    });
  }

  resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalRecord> {
    return this.#json<ApprovalRecord>(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved }),
    });
  }

  getSession(sessionId: string): Promise<SessionRecord> {
    return this.#json<SessionRecord>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getSessionMessages(sessionId: string): Promise<SessionMessageRecord[]> {
    const response = await this.#json<{ messages: SessionMessageRecord[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    return response.messages;
  }

  publishArtifact(runId: string, request: PublishArtifactRequest): Promise<ArtifactRecord> {
    return this.#json<ArtifactRecord>(`/v1/runs/${encodeURIComponent(runId)}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async downloadArtifact(artifactId: string): Promise<{ record: ArtifactRecord; data: Uint8Array }> {
    const payload = await this.#json<ArtifactPayloadResponse>(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
    return { record: payload.record, data: Uint8Array.from(Buffer.from(payload.dataBase64, "base64")) };
  }

  createAgent(request: CreateAgentProfileRequest): Promise<AgentProfileRecord> {
    return this.#json<AgentProfileRecord>("/v1/agents", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
  }

  getAgent(agentId: string): Promise<AgentProfileRecord> {
    return this.#json<AgentProfileRecord>(`/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async listAgents(): Promise<AgentProfileRecord[]> {
    return (await this.#json<{ agents: AgentProfileRecord[] }>("/v1/agents")).agents;
  }

  createWorkspace(request: CreateWorkspaceRequest = {}): Promise<WorkspaceRecord> {
    return this.#json<WorkspaceRecord>("/v1/workspaces", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    return this.#json<WorkspaceRecord>(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return (await this.#json<{ workspaces: WorkspaceRecord[] }>("/v1/workspaces")).workspaces;
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
        const response = await this.#fetch(
          this.#url(`/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}`),
          { headers: this.#headers(), signal: options.signal },
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

        const run = await this.#json<RunRecord>(`/v1/runs/${encodeURIComponent(runId)}`, { signal: options.signal });
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

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}` };
  }

  #url(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }
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
