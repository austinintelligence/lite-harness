import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Value } from "@sinclair/typebox/value";
import {
  type CreateRunResponse,
  type ArtifactPayloadResponse,
  type ArtifactRecord,
  type ApprovalRecord,
  type AgentProfileRecord,
  type WorkspaceRecord,
  type RunAttemptRecord,
  type CreateAgentProfileRequest,
  type CreateWorkspaceRequest,
  CreateAgentProfileRequestSchema,
  CreateRunRequestSchema,
  CreateWorkspaceRequestSchema,
  isTerminalRunStatus,
  type CreateRunRequest,
  type InternalPrincipal,
  type InternalStartRunRequest,
  type PublishArtifactRequest,
  type RunEvent,
  type RunRecord,
  type SessionMessageRecord,
  type SessionRecord,
} from "@lite-harness/contracts";

export interface ManagerTransport {
  health(): Promise<{ ok: boolean; role: string; uptimeSeconds: number; rssBytes: number }>;
  startRun(request: InternalStartRunRequest): Promise<CreateRunResponse>;
  getRun(runId: string): Promise<RunRecord>;
  cancelRun(runId: string): Promise<RunRecord>;
  steerRun(runId: string, instruction: string): Promise<RunRecord>;
  getApproval(approvalId: string): Promise<ApprovalRecord>;
  resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalRecord>;
  getEvents(runId: string, after: number, waitMs: number): Promise<RunEvent[]>;
  getRunAttempts(runId: string): Promise<RunAttemptRecord[]>;
  getChildRuns(runId: string): Promise<RunRecord[]>;
  getSession(sessionId: string): Promise<SessionRecord>;
  getSessionMessages(sessionId: string): Promise<SessionMessageRecord[]>;
  publishArtifact(runId: string, request: PublishArtifactRequest, principal: InternalPrincipal): Promise<ArtifactRecord>;
  getArtifact(artifactId: string, principal: InternalPrincipal): Promise<ArtifactPayloadResponse>;
  createAgent(request: CreateAgentProfileRequest, principal: InternalPrincipal): Promise<AgentProfileRecord>;
  getAgent(agentId: string, principal: InternalPrincipal): Promise<AgentProfileRecord>;
  listAgents(principal: InternalPrincipal): Promise<AgentProfileRecord[]>;
  createWorkspace(request: CreateWorkspaceRequest, principal: InternalPrincipal): Promise<WorkspaceRecord>;
  getWorkspace(workspaceId: string, principal: InternalPrincipal): Promise<WorkspaceRecord>;
  listWorkspaces(principal: InternalPrincipal): Promise<WorkspaceRecord[]>;
  ingestWebhook(accountId: string, envelope: unknown, signature: string): Promise<{ duplicate: boolean; runId?: string }>;
}

export interface GatewayServerOptions {
  manager: ManagerTransport;
  appToken: string;
  logger?: boolean;
}

export function buildGatewayServer(options: GatewayServerOptions): FastifyInstance {
  if (!options.appToken.trim()) throw new Error("Gateway app token must be non-empty");
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/readyz" || request.url.startsWith("/hooks/")) {
      return;
    }
    if (!constantTimeBearerMatch(request.headers.authorization, options.appToken)) {
      await reply.code(401).send({ error: { code: "unauthorized", message: "Invalid app token" } });
    }
  });

  app.get("/healthz", async () => ({
    ok: true, role: "gateway", uptimeSeconds: Math.floor(process.uptime()), rssBytes: process.memoryUsage().rss,
  }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const manager = await options.manager.health();
      if (!manager.ok) throw new Error("Manager reported unhealthy");
      return { ok: true, role: "gateway", dependencies: { manager } };
    } catch {
      return reply.code(503).send({
        ok: false,
        role: "gateway",
        dependencies: { manager: { ok: false } },
      });
    }
  });

  app.post<{ Params: { accountId: string }; Body: unknown }>("/hooks/webhook/:accountId", async (request, reply) => {
    const signature = stringHeader(request.headers["x-lite-signature"]);
    if (!signature || !request.body || typeof request.body !== "object") {
      return reply.code(400).send({ error: { code: "invalid_webhook", message: "Webhook body and X-Lite-Signature are required" } });
    }
    try {
      return reply.code(202).send(await options.manager.ingestWebhook(request.params.accountId, request.body, signature));
    } catch (error) {
      return reply.code(401).send({ error: { code: "webhook_rejected", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.post<{ Body: CreateRunRequest }>("/v1/runs", async (request, reply) => {
    if (!Value.Check(CreateRunRequestSchema, request.body)) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Run body does not match the schema" },
      });
    }
    const idempotencyKey = stringHeader(request.headers["idempotency-key"]) ?? randomUUID();
    if (idempotencyKey.length > 200) {
      return reply.code(400).send({
        error: { code: "invalid_idempotency_key", message: "Idempotency key is too long" },
      });
    }
    const response = await options.manager.startRun({
      ...request.body,
      idempotencyKey,
      principal: principalFromHeaders(request.headers),
    });
    return reply.code(202).send(response);
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
    try {
      const run = await options.manager.getRun(request.params.runId);
      return ownsRun(run, principalFromHeaders(request.headers))
        ? run
        : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    } catch (error) {
      return reply.code(404).send({
        error: { code: "not_found", message: error instanceof Error ? error.message : "Run not found" },
      });
    }
  });

  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/cancel", async (request, reply) => {
    try {
      const existing = await options.manager.getRun(request.params.runId);
      if (!ownsRun(existing, principalFromHeaders(request.headers))) {
        return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
      }
      return await options.manager.cancelRun(request.params.runId);
    } catch (error) {
      return reply.code(404).send({
        error: { code: "not_found", message: error instanceof Error ? error.message : "Run not found" },
      });
    }
  });

  app.post<{ Params: { runId: string }; Body: { instruction?: string } }>(
    "/v1/runs/:runId/steer",
    async (request, reply) => {
      const principal = principalFromHeaders(request.headers);
      try {
        const run = await options.manager.getRun(request.params.runId);
        if (!ownsRun(run, principal)) return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
        if (typeof request.body?.instruction !== "string" || !request.body.instruction.trim()) {
          return reply.code(400).send({ error: { code: "invalid_request", message: "Steering instruction is required" } });
        }
        return await options.manager.steerRun(run.id, request.body.instruction);
      } catch (error) {
        return reply.code(409).send({ error: { code: "run_not_active", message: error instanceof Error ? error.message : String(error) } });
      }
    },
  );

  app.post<{ Params: { approvalId: string }; Body: { approved?: boolean } }>(
    "/v1/approvals/:approvalId",
    async (request, reply) => {
      if (typeof request.body?.approved !== "boolean") {
        return reply.code(400).send({ error: { code: "invalid_request", message: "approved must be boolean" } });
      }
      const principal = principalFromHeaders(request.headers);
      try {
        const approval = await options.manager.getApproval(request.params.approvalId);
        const run = await options.manager.getRun(approval.runId);
        if (!ownsRun(run, principal)) return reply.code(404).send({ error: { code: "not_found", message: "Approval not found" } });
        return await options.manager.resolveApproval(approval.id, request.body.approved);
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Approval not found" } });
      }
    },
  );

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>(
    "/v1/runs/:runId/events",
    async (request, reply) => {
      const startAfter = parseCursor(request.query.after);
      try {
        const run = await options.manager.getRun(request.params.runId);
        if (!ownsRun(run, principalFromHeaders(request.headers))) {
          return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
        }
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
      }
      const response = reply.raw;
      reply.hijack();
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      let cursor = startAfter;
      let closed = false;
      request.raw.once("close", () => {
        closed = true;
      });

      try {
        while (!closed) {
          const events = await options.manager.getEvents(request.params.runId, cursor, 5_000);
          for (const event of events) {
            response.write(`id: ${event.sequence}\n`);
            response.write(`event: ${event.type}\n`);
            response.write(`data: ${JSON.stringify(event)}\n\n`);
            cursor = event.sequence;
          }
          const run = await options.manager.getRun(request.params.runId);
          if (isTerminalRunStatus(run.status) && cursor >= run.lastSequence) {
            break;
          }
          if (events.length === 0) {
            response.write(": keepalive\n\n");
          }
        }
      } catch (error) {
        if (!closed) {
          response.write(
            `event: stream.error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`,
          );
        }
      } finally {
        if (!closed) {
          response.end();
        }
      }
    },
  );

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/attempts", async (request, reply) => {
    const principal = principalFromHeaders(request.headers);
    try {
      const run = await options.manager.getRun(request.params.runId);
      return ownsRun(run, principal)
        ? { attempts: await options.manager.getRunAttempts(run.id) }
        : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    } catch {
      return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    }
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/children", async (request, reply) => {
    const principal = principalFromHeaders(request.headers);
    try {
      const run = await options.manager.getRun(request.params.runId);
      return ownsRun(run, principal)
        ? { runs: await options.manager.getChildRuns(run.id) }
        : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    } catch {
      return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      try {
        const session = await options.manager.getSession(request.params.sessionId);
        return ownsRun(session, principalFromHeaders(request.headers))
          ? session
          : reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
      }
    },
  );

  app.post<{ Params: { runId: string }; Body: PublishArtifactRequest }>(
    "/v1/runs/:runId/artifacts",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request, reply) => {
      const principal = principalFromHeaders(request.headers);
      try {
        const run = await options.manager.getRun(request.params.runId);
        if (!ownsRun(run, principal)) return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
        if (!isPublishArtifactRequest(request.body)) return reply.code(400).send({ error: { code: "invalid_request", message: "Malformed artifact request" } });
        return reply.code(201).send(await options.manager.publishArtifact(run.id, request.body, principal));
      } catch (error) {
        return reply.code(400).send({ error: { code: "artifact_publish_failed", message: error instanceof Error ? error.message : String(error) } });
      }
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/v1/artifacts/:artifactId",
    async (request, reply) => {
      try {
        return await options.manager.getArtifact(request.params.artifactId, principalFromHeaders(request.headers));
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Artifact not found" } });
      }
    },
  );

  app.post<{ Body: CreateAgentProfileRequest }>("/v1/agents", async (request, reply) => {
    if (!Value.Check(CreateAgentProfileRequestSchema, request.body)) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Agent body does not match the schema" } });
    }
    return reply.code(201).send(await options.manager.createAgent(request.body, principalFromHeaders(request.headers)));
  });

  app.get("/v1/agents", async (request) => ({
    agents: await options.manager.listAgents(principalFromHeaders(request.headers)),
  }));

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request, reply) => {
    try { return await options.manager.getAgent(request.params.agentId, principalFromHeaders(request.headers)); }
    catch { return reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } }); }
  });

  app.post<{ Body: CreateWorkspaceRequest }>("/v1/workspaces", async (request, reply) => {
    if (!Value.Check(CreateWorkspaceRequestSchema, request.body ?? {})) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Workspace body does not match the schema" } });
    }
    return reply.code(201).send(await options.manager.createWorkspace(request.body ?? {}, principalFromHeaders(request.headers)));
  });

  app.get("/v1/workspaces", async (request) => ({
    workspaces: await options.manager.listWorkspaces(principalFromHeaders(request.headers)),
  }));

  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId", async (request, reply) => {
    try { return await options.manager.getWorkspace(request.params.workspaceId, principalFromHeaders(request.headers)); }
    catch { return reply.code(404).send({ error: { code: "not_found", message: "Workspace not found" } }); }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      try {
        const session = await options.manager.getSession(request.params.sessionId);
        if (!ownsRun(session, principalFromHeaders(request.headers))) {
          return reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
        }
        return { messages: await options.manager.getSessionMessages(request.params.sessionId) };
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
      }
    },
  );

  return app;
}

function isPublishArtifactRequest(value: unknown): value is PublishArtifactRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && record.path.length > 0 &&
    typeof record.mediaType === "string" && record.mediaType.length > 0 &&
    typeof record.dataBase64 === "string" && record.dataBase64.length <= 24 * 1024 * 1024;
}

function principalFromHeaders(headers: Record<string, unknown>): InternalPrincipal {
  return {
    appId: "app_local",
    tenantId: stringHeader(headers["x-lite-tenant-id"]) ?? "tenant_local",
    userId: stringHeader(headers["x-lite-user-id"]) ?? "user_local",
    scopes: ["runs:create", "runs:read", "runs:cancel", "events:read"],
  };
}

function stringHeader(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCursor(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function constantTimeBearerMatch(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

function ownsRun(
  run: { appId: string; tenantId: string; userId: string },
  principal: InternalPrincipal,
): boolean {
  return (
    run.appId === principal.appId &&
    run.tenantId === principal.tenantId &&
    run.userId === principal.userId
  );
}
