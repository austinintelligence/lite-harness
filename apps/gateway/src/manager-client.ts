import { request as httpRequest } from "node:http";
import type {
  CreateRunResponse,
  ArtifactPayloadResponse,
  ArtifactRecord,
  ApprovalRecord,
  AgentProfileRecord,
  WorkspaceRecord,
  RunAttemptRecord,
  CreateAgentProfileRequest,
  CreateWorkspaceRequest,
  InternalPrincipal,
  PublishArtifactRequest,
  InternalStartRunRequest,
  RunEvent,
  RunRecord,
  SessionMessageRecord,
  SessionRecord,
  ErrorEnvelope,
  ManagerHealth,
} from "@lite-harness/contracts";
import { LITE_IPC_PROTOCOL_VERSION, LITE_IPC_VERSION_HEADER } from "@lite-harness/contracts";

export class ManagerIpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ManagerIpcError";
  }
}

export class ManagerClient {
  constructor(
    private readonly socketPath: string,
    private readonly internalToken: string,
    private readonly timeoutMs = 15_000,
    private readonly maxResponseBytes = 32 * 1024 * 1024,
  ) {}

  async health(): Promise<ManagerHealth> {
    const health = await this.#request<ManagerHealth>("GET", "/healthz");
    if (health.protocolVersion !== LITE_IPC_PROTOCOL_VERSION) {
      throw new ManagerIpcError(
        426,
        "ipc_version_mismatch",
        `Gateway requires Manager IPC protocol ${LITE_IPC_PROTOCOL_VERSION}; received ${String(health.protocolVersion)}`,
      );
    }
    return health;
  }

  startRun(request: InternalStartRunRequest): Promise<CreateRunResponse> {
    return this.#request<CreateRunResponse>("POST", "/internal/runs", request);
  }

  getRun(runId: string): Promise<RunRecord> {
    return this.#request<RunRecord>("GET", `/internal/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId: string): Promise<RunRecord> {
    return this.#request<RunRecord>("POST", `/internal/runs/${encodeURIComponent(runId)}/cancel`);
  }

  steerRun(runId: string, instruction: string): Promise<RunRecord> {
    return this.#request<RunRecord>("POST", `/internal/runs/${encodeURIComponent(runId)}/steer`, { instruction });
  }

  getApproval(approvalId: string): Promise<ApprovalRecord> {
    return this.#request<ApprovalRecord>("GET", `/internal/approvals/${encodeURIComponent(approvalId)}`);
  }

  resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalRecord> {
    return this.#request<ApprovalRecord>("POST", `/internal/approvals/${encodeURIComponent(approvalId)}/resolve`, { approved });
  }

  async getEvents(runId: string, after: number, waitMs: number): Promise<RunEvent[]> {
    const result = await this.#request<{ events: RunEvent[] }>(
      "GET",
      `/internal/runs/${encodeURIComponent(runId)}/events?after=${after}&wait_ms=${waitMs}`,
    );
    return result.events;
  }

  async getRunAttempts(runId: string): Promise<RunAttemptRecord[]> {
    return (await this.#request<{ attempts: RunAttemptRecord[] }>(
      "GET", `/internal/runs/${encodeURIComponent(runId)}/attempts`,
    )).attempts;
  }

  async getChildRuns(runId: string): Promise<RunRecord[]> {
    return (await this.#request<{ runs: RunRecord[] }>(
      "GET", `/internal/runs/${encodeURIComponent(runId)}/children`,
    )).runs;
  }

  getSession(sessionId: string): Promise<SessionRecord> {
    return this.#request<SessionRecord>("GET", `/internal/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getSessionMessages(sessionId: string): Promise<SessionMessageRecord[]> {
    const result = await this.#request<{ messages: SessionMessageRecord[] }>(
      "GET",
      `/internal/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    return result.messages;
  }

  publishArtifact(
    runId: string,
    request: PublishArtifactRequest,
    principal: InternalPrincipal,
  ): Promise<ArtifactRecord> {
    return this.#request<ArtifactRecord>("POST", `/internal/runs/${encodeURIComponent(runId)}/artifacts`, {
      ...request,
      principal,
    });
  }

  getArtifact(artifactId: string, principal: InternalPrincipal): Promise<ArtifactPayloadResponse> {
    return this.#request<ArtifactPayloadResponse>(
      "GET",
      `/internal/artifacts/${encodeURIComponent(artifactId)}`,
      undefined,
      {
        "x-lite-app-id": principal.appId,
        "x-lite-tenant-id": principal.tenantId,
        "x-lite-user-id": principal.userId,
      },
    );
  }

  createAgent(request: CreateAgentProfileRequest, principal: InternalPrincipal): Promise<AgentProfileRecord> {
    return this.#request<AgentProfileRecord>("POST", "/internal/agents", { ...request, principal });
  }

  getAgent(agentId: string, principal: InternalPrincipal): Promise<AgentProfileRecord> {
    return this.#request<AgentProfileRecord>("GET", `/internal/agents/${encodeURIComponent(agentId)}`, undefined, principalHeaders(principal));
  }

  listAgents(principal: InternalPrincipal): Promise<AgentProfileRecord[]> {
    return this.#request<{ agents: AgentProfileRecord[] }>("GET", "/internal/agents", undefined, principalHeaders(principal)).then((value) => value.agents);
  }

  createWorkspace(request: CreateWorkspaceRequest, principal: InternalPrincipal): Promise<WorkspaceRecord> {
    return this.#request<WorkspaceRecord>("POST", "/internal/workspaces", { ...request, principal });
  }

  getWorkspace(workspaceId: string, principal: InternalPrincipal): Promise<WorkspaceRecord> {
    return this.#request<WorkspaceRecord>("GET", `/internal/workspaces/${encodeURIComponent(workspaceId)}`, undefined, principalHeaders(principal));
  }

  listWorkspaces(principal: InternalPrincipal): Promise<WorkspaceRecord[]> {
    return this.#request<{ workspaces: WorkspaceRecord[] }>("GET", "/internal/workspaces", undefined, principalHeaders(principal)).then((value) => value.workspaces);
  }

  ingestWebhook(accountId: string, envelope: unknown, signature: string): Promise<{ duplicate: boolean; runId?: string }> {
    return this.#request("POST", `/internal/integrations/webhook/${encodeURIComponent(accountId)}/inbound`, { envelope, signature });
  }

  #request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    additionalHeaders: Record<string, string> = {},
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            "x-lite-internal-token": this.internalToken,
            [LITE_IPC_VERSION_HEADER]: LITE_IPC_PROTOCOL_VERSION,
            accept: "application/json",
            ...additionalHeaders,
            ...(payload
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > this.maxResponseBytes) response.destroy(new Error("Manager IPC response exceeded the size limit"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              reject(new Error(`Manager returned invalid JSON (${response.statusCode}): ${text}`));
              return;
            }
            if ((response.statusCode ?? 500) >= 400) {
              const envelope = parseErrorEnvelope(parsed);
              reject(envelope
                ? new ManagerIpcError(
                  response.statusCode ?? 500,
                  envelope.error.code,
                  envelope.error.message,
                  envelope.error.retryable,
                  envelope.error.details,
                )
                : new ManagerIpcError(response.statusCode ?? 500, "ipc_invalid_error", text || "Manager request failed"));
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      request.once("error", reject);
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`Manager IPC request timed out after ${this.timeoutMs}ms`));
      });
      request.end(payload);
    });
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

function principalHeaders(principal: InternalPrincipal): Record<string, string> {
  return {
    "x-lite-app-id": principal.appId,
    "x-lite-tenant-id": principal.tenantId,
    "x-lite-user-id": principal.userId,
  };
}
