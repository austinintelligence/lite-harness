import Fastify, { type FastifyInstance } from "fastify";
import type {
  ArtifactPayloadResponse,
  InternalPrincipal,
  InternalPublishArtifactRequest,
  InternalStartRunRequest,
  InternalCreateAgentProfileRequest,
  InternalCreateWorkspaceRequest,
} from "@lite-harness/contracts";
import { DEFAULT_RUN_BUDGET } from "@lite-harness/contracts";
import { randomUUID } from "node:crypto";
import { RunService } from "@lite-harness/control-plane";
import type { LocalArtifactStore } from "@lite-harness/workspace";
import type { InboundRunRouter, SqliteIntegrationStore } from "@lite-harness/integrations";
import { normalizeInbound, verifyHmacSha256 } from "@lite-harness/integrations";

export interface ManagerServerOptions {
  runService: RunService;
  internalToken: string;
  artifactStore?: LocalArtifactStore;
  integrationRouter?: InboundRunRouter;
  integrationStore?: SqliteIntegrationStore;
  webhookSecret?: (accountId: string) => Promise<Buffer | undefined>;
  logger?: boolean;
}

export function buildManagerServer(options: ManagerServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") {
      return;
    }
    if (request.headers["x-lite-internal-token"] !== options.internalToken) {
      await reply.code(401).send({ error: { code: "unauthorized", message: "Invalid IPC token" } });
    }
  });

  app.get("/healthz", async () => ({ ok: true, role: "manager" }));

  app.post<{ Params: { accountId: string }; Body: { envelope?: unknown; signature?: string } }>(
    "/internal/integrations/webhook/:accountId/inbound",
    async (request, reply) => {
      if (!options.integrationRouter || !options.integrationStore || !options.webhookSecret ||
          !request.body?.envelope || typeof request.body.signature !== "string") {
        return reply.code(404).send({ error: { code: "integration_unavailable", message: "Webhook integration is not configured" } });
      }
      const secret = await options.webhookSecret(request.params.accountId);
      const canonical = Buffer.from(JSON.stringify(request.body.envelope));
      if (!secret || !verifyHmacSha256(canonical, request.body.signature, secret)) {
        return reply.code(401).send({ error: { code: "invalid_signature", message: "Webhook signature is invalid" } });
      }
      try {
        const source = request.body.envelope as Record<string, unknown>;
        const envelope = normalizeInbound({ ...source, connectorId: "webhook", accountId: request.params.accountId });
        return reply.code(202).send(await options.integrationRouter.route(envelope));
      } catch (error) {
        return reply.code(400).send({ error: { code: "invalid_envelope", message: error instanceof Error ? error.message : String(error) } });
      }
    },
  );

  app.post<{ Body: InternalStartRunRequest }>("/internal/runs", async (request, reply) => {
    const body = request.body;
    if (!isInternalStartRunRequest(body)) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Malformed internal run request" },
      });
    }
    return reply.code(202).send(options.runService.createRun(body));
  });

  app.get<{ Params: { runId: string } }>("/internal/runs/:runId", async (request, reply) => {
    const run = options.runService.getRun(request.params.runId);
    return run
      ? reply.send(run)
      : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
  });

  app.get<{
    Params: { runId: string };
    Querystring: { after?: string; wait_ms?: string };
  }>("/internal/runs/:runId/events", async (request, reply) => {
    if (!options.runService.getRun(request.params.runId)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    }
    const after = boundedInteger(request.query.after, 0, Number.MAX_SAFE_INTEGER, 0);
    const waitMs = boundedInteger(request.query.wait_ms, 0, 10_000, 0);
    const events = await options.runService.waitForEvents(request.params.runId, after, waitMs);
    return reply.send({ events });
  });

  app.get<{ Params: { runId: string } }>("/internal/runs/:runId/attempts", async (request, reply) => {
    return options.runService.getRun(request.params.runId)
      ? { attempts: options.runService.listRunAttempts(request.params.runId) }
      : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
  });

  app.post<{ Params: { runId: string } }>(
    "/internal/runs/:runId/cancel",
    async (request, reply) => {
      const run = options.runService.cancelRun(request.params.runId);
      return run
        ? reply.send(run)
        : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    },
  );

  app.post<{ Params: { runId: string }; Body: { instruction?: string } }>(
    "/internal/runs/:runId/steer",
    async (request, reply) => {
      if (typeof request.body?.instruction !== "string" || !request.body.instruction.trim()) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Steering instruction is required" } });
      }
      try {
        return options.runService.steerRun(request.params.runId, request.body.instruction);
      } catch (error) {
        return reply.code(409).send({ error: { code: "run_not_active", message: error instanceof Error ? error.message : String(error) } });
      }
    },
  );

  app.get<{ Params: { approvalId: string } }>(
    "/internal/approvals/:approvalId",
    async (request, reply) => {
      const approval = options.runService.getApproval(request.params.approvalId);
      return approval
        ? approval
        : reply.code(404).send({ error: { code: "not_found", message: "Approval not found" } });
    },
  );

  app.post<{ Params: { approvalId: string }; Body: { approved?: boolean } }>(
    "/internal/approvals/:approvalId/resolve",
    async (request, reply) => {
      if (typeof request.body?.approved !== "boolean") {
        return reply.code(400).send({ error: { code: "invalid_request", message: "approved must be boolean" } });
      }
      const approval = options.runService.resolveApproval(request.params.approvalId, request.body.approved);
      return approval
        ? approval
        : reply.code(404).send({ error: { code: "not_found", message: "Approval not found" } });
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/internal/sessions/:sessionId",
    async (request, reply) => {
      const session = options.runService.getSession(request.params.sessionId);
      return session
        ? reply.send(session)
        : reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
    },
  );

  app.post<{ Params: { runId: string }; Body: InternalPublishArtifactRequest }>(
    "/internal/runs/:runId/artifacts",
    async (request, reply) => {
      if (!options.artifactStore || !isInternalArtifactRequest(request.body)) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Malformed artifact request" } });
      }
      const run = options.runService.getRun(request.params.runId);
      if (!run || !samePrincipal(run, request.body.principal)) {
        return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
      }
      const data = Buffer.from(request.body.dataBase64, "base64");
      if (data.length > 16 * 1024 * 1024) {
        return reply.code(413).send({ error: { code: "artifact_too_large", message: "Artifact exceeds 16 MiB" } });
      }
      const record = options.artifactStore.publish({
        runId: run.id,
        workspaceId: run.workspaceId,
        principal: request.body.principal,
        path: request.body.path,
        mediaType: request.body.mediaType,
        data,
      });
      return reply.code(201).send(record);
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/internal/artifacts/:artifactId",
    async (request, reply) => {
      if (!options.artifactStore) return reply.code(404).send({ error: { code: "not_found", message: "Artifact not found" } });
      const principal = principalFromInternalHeaders(request.headers);
      const payload = options.artifactStore.get(request.params.artifactId, principal);
      if (!payload) return reply.code(404).send({ error: { code: "not_found", message: "Artifact not found" } });
      const response: ArtifactPayloadResponse = { record: payload.record, dataBase64: payload.data.toString("base64") };
      return response;
    },
  );

  app.post<{ Body: InternalCreateAgentProfileRequest }>("/internal/agents", async (request, reply) => {
    const body = request.body;
    if (!body?.principal || typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Agent name and principal are required" } });
    }
    const now = new Date().toISOString();
    return reply.code(201).send(options.runService.createAgentProfile({
      id: body.id ?? `agt_${randomUUID().replaceAll("-", "")}`,
      version: 1,
      appId: body.principal.appId,
      tenantId: body.principal.tenantId,
      userId: body.principal.userId,
      name: body.name,
      instructions: body.instructions ?? "",
      modelCapabilities: body.modelCapabilities ?? ["text", "tools"],
      allowedTools: body.allowedTools ?? ["read_file", "write_file"],
      defaultBudget: { ...DEFAULT_RUN_BUDGET, ...(body.defaultBudget ?? {}) },
      createdAt: now,
    }));
  });

  app.get("/internal/agents", async (request) => ({
    agents: options.runService.listAgentProfiles(principalFromInternalHeaders(request.headers)),
  }));

  app.get<{ Params: { agentId: string } }>("/internal/agents/:agentId", async (request, reply) => {
    const agent = options.runService.getAgentProfile(request.params.agentId);
    return agent && samePrincipal(agent, principalFromInternalHeaders(request.headers))
      ? agent
      : reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });
  });

  app.post<{ Body: InternalCreateWorkspaceRequest }>("/internal/workspaces", async (request, reply) => {
    const body = request.body;
    if (!body?.principal || (body.mode !== undefined && body.mode !== "managed")) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Only managed public workspaces are supported" } });
    }
    const now = new Date().toISOString();
    return reply.code(201).send(options.runService.createWorkspace({
      id: body.id ?? `wsp_${randomUUID().replaceAll("-", "")}`,
      appId: body.principal.appId,
      tenantId: body.principal.tenantId,
      userId: body.principal.userId,
      mode: "managed",
      state: "WARM",
      createdAt: now,
      updatedAt: now,
    }));
  });

  app.get("/internal/workspaces", async (request) => ({
    workspaces: options.runService.listWorkspaces(principalFromInternalHeaders(request.headers)),
  }));

  app.get<{ Params: { workspaceId: string } }>("/internal/workspaces/:workspaceId", async (request, reply) => {
    const workspace = options.runService.getWorkspace(request.params.workspaceId);
    return workspace && samePrincipal(workspace, principalFromInternalHeaders(request.headers))
      ? workspace
      : reply.code(404).send({ error: { code: "not_found", message: "Workspace not found" } });
  });

  app.get<{ Params: { sessionId: string } }>(
    "/internal/sessions/:sessionId/messages",
    async (request, reply) => {
      const session = options.runService.getSession(request.params.sessionId);
      return session
        ? reply.send({ messages: options.runService.listSessionMessages(request.params.sessionId) })
        : reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
    },
  );

  return app;
}

function isInternalArtifactRequest(value: unknown): value is InternalPublishArtifactRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const principal = record.principal as Record<string, unknown> | undefined;
  return typeof record.path === "string" && typeof record.mediaType === "string" &&
    typeof record.dataBase64 === "string" && Boolean(principal) &&
    typeof principal?.appId === "string" && typeof principal.tenantId === "string" &&
    typeof principal.userId === "string" && Array.isArray(principal.scopes);
}

function principalFromInternalHeaders(headers: Record<string, unknown>): InternalPrincipal {
  const value = (name: string) => typeof headers[name] === "string" ? headers[name] as string : "";
  return { appId: value("x-lite-app-id"), tenantId: value("x-lite-tenant-id"), userId: value("x-lite-user-id"), scopes: [] };
}

function samePrincipal(
  resource: { appId: string; tenantId: string; userId: string },
  principal: InternalPrincipal,
): boolean {
  return resource.appId === principal.appId && resource.tenantId === principal.tenantId && resource.userId === principal.userId;
}

function boundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function isInternalStartRunRequest(value: unknown): value is InternalStartRunRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const principal = record.principal as Record<string, unknown> | undefined;
  return (
    typeof record.agent === "string" &&
    typeof record.workspace === "string" &&
    typeof record.input === "string" &&
    typeof record.idempotencyKey === "string" &&
    Boolean(principal) &&
    typeof principal?.appId === "string" &&
    typeof principal.tenantId === "string" &&
    typeof principal.userId === "string" &&
    Array.isArray(principal.scopes) &&
    principal.scopes.every((scope) => typeof scope === "string")
  );
}
