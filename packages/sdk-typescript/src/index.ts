import { randomUUID } from "node:crypto";
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

  async *events(runId: string, after = 0): AsyncIterable<RunEvent> {
    const response = await this.#fetch(
      this.#url(`/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`),
      { headers: this.#headers() },
    );
    if (!response.ok || !response.body) {
      throw new LiteHarnessError(`Event stream failed with HTTP ${response.status}`, response.status, "event_stream_failed");
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) {
          const parsed = JSON.parse(data) as RunEvent | { message: string };
          if ("runId" in parsed) {
            yield parsed;
          } else {
            throw new LiteHarnessError(parsed.message, undefined, "event_stream_error");
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        return;
      }
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
