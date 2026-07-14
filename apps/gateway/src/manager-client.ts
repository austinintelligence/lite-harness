import { request as httpRequest } from "node:http";
import type {
  CreateRunResponse,
  ArtifactPayloadResponse,
  ArtifactRecord,
  ApprovalRecord,
  InternalPrincipal,
  PublishArtifactRequest,
  InternalStartRunRequest,
  RunEvent,
  RunRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@lite-harness/contracts";

export class ManagerClient {
  constructor(
    private readonly socketPath: string,
    private readonly internalToken: string,
    private readonly timeoutMs = 15_000,
  ) {}

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
            accept: "application/json",
            ...additionalHeaders,
            ...(payload
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
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
              const message =
                typeof parsed === "object" && parsed && "error" in parsed
                  ? JSON.stringify((parsed as { error: unknown }).error)
                  : text;
              reject(new Error(`Manager request failed (${response.statusCode}): ${message}`));
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
