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
} from "@lite-harness/contracts";

export interface LiteHarnessClientOptions {
  baseUrl: string;
  token: string;
  tenantId?: string;
  userId?: string;
  fetch?: typeof globalThis.fetch;
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
      throw new Error(`Event stream failed with HTTP ${response.status}`);
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
            throw new Error(parsed.message);
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
    const body = (await response.json()) as T | { error?: { message?: string } };
    if (!response.ok) {
      const message = "error" in (body as object)
        ? (body as { error?: { message?: string } }).error?.message
        : undefined;
      throw new Error(message ?? `Lite-Harness request failed with HTTP ${response.status}`);
    }
    return body as T;
  }

  #headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.token}`,
      ...(this.options.tenantId ? { "x-lite-tenant-id": this.options.tenantId } : {}),
      ...(this.options.userId ? { "x-lite-user-id": this.options.userId } : {}),
    };
  }

  #url(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }
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
} from "@lite-harness/contracts";
