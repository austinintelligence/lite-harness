import Fastify, { type FastifyInstance } from "fastify";
import { Value } from "@sinclair/typebox/value";
import type {
  ArtifactPayloadResponse,
  InternalPrincipal,
  InternalPublishArtifactRequest,
  InternalStartRunRequest,
  InternalCreateAgentProfileRequest,
  InternalCreateWorkspaceRequest,
  ManagerHealth,
  ManagerReadiness,
  ReadinessDependency,
} from "@lite-harness/contracts";
import {
  DEFAULT_RUN_BUDGET,
  InternalCreateAgentProfileRequestSchema,
  InternalCreateWorkspaceRequestSchema,
  InternalPublishArtifactRequestSchema,
  InternalStartRunRequestSchema,
  LITE_IPC_PROTOCOL_VERSION,
  LITE_IPC_VERSION_HEADER,
  errorEnvelope,
} from "@lite-harness/contracts";
import { randomUUID } from "node:crypto";
import { RunService } from "@lite-harness/control-plane";
import { StructuredObservability, type TraceSpan } from "@lite-harness/observability";
import type { LocalArtifactStore } from "@lite-harness/workspace";
import type { InboundRunRouter, SqliteIntegrationStore } from "@lite-harness/integrations";
import { normalizeInbound, verifyHmacSha256 } from "@lite-harness/integrations";

declare module "fastify" {
  interface FastifyRequest { rawBody?: Buffer }
}

export interface ManagerServerOptions {
  runService: RunService;
  internalToken: string;
  instanceId?: string;
  artifactStore?: LocalArtifactStore;
  readWorkspaceArtifact?: (params: {
    runId: string;
    workspaceId: string;
    attemptId: string;
    fencingToken: number;
    principal: InternalPrincipal;
    path: string;
    maxBytes: number;
  }) => Promise<Buffer>;
  integrationRouter?: InboundRunRouter;
  integrationStore?: SqliteIntegrationStore;
  webhookSecret?: (accountId: string) => Promise<Buffer | undefined>;
  logger?: boolean;
  observability?: StructuredObservability;
  productionReadinessChecks: () => Promise<Record<string, ReadinessDependency>>;
}

export function buildManagerServer(options: ManagerServerOptions): FastifyInstance {
  if (!options.internalToken.trim()) throw new Error("Manager IPC token must be non-empty");
  const app = Fastify({ logger: options.logger ?? false });
  const observability = options.observability ?? new StructuredObservability();
  const requestSpans = new WeakMap<object, TraceSpan>();
  installExactJsonBodyParser(app);

  app.addHook("preSerialization", async (_request, reply, payload) => {
    if (reply.statusCode < 400 || !payload || typeof payload !== "object" || !("error" in payload)) return payload;
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== "object") return payload;
    const record = error as Record<string, unknown>;
    if (record.version === 1) return payload;
    return errorEnvelope(
      typeof record.code === "string" ? record.code : "ipc_request_failed",
      typeof record.message === "string" ? record.message : "Manager request failed",
      { retryable: record.retryable === true },
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    const caught = error instanceof Error ? error : new Error("Unknown Manager error");
    const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
    const status = typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
      ? statusCode
      : 500;
    return reply.code(status).send(errorEnvelope(
      status === 500 ? "internal_error" : "invalid_request",
      status === 500 ? "Internal Manager error" : caught.message,
    ));
  });

  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0];
    const span = observability.startTrace("http.request", {
      service: "manager", method: request.method, route,
    });
    requestSpans.set(request, span);
    reply.header("x-lite-trace-id", span.traceId);
  });

  app.addHook("onResponse", async (request, reply) => {
    const span = requestSpans.get(request);
    if (!span) return;
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0];
    const statusCode = reply.statusCode;
    const outcome = statusCode >= 400 ? "failed" : "completed";
    span.end({ statusCode, outcome });
    observability.audit("http.request", outcome, {
      service: "manager", method: request.method, route, statusCode,
    }, span);
    observability.counter("http.requests.total", 1, {
      service: "manager", method: request.method, route, statusCode,
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") {
      return;
    }
    if (request.headers[LITE_IPC_VERSION_HEADER] !== LITE_IPC_PROTOCOL_VERSION) {
      await reply.code(426).send(errorEnvelope(
        "ipc_version_mismatch",
        `Manager requires IPC protocol ${LITE_IPC_PROTOCOL_VERSION}`,
        { details: { supported: [LITE_IPC_PROTOCOL_VERSION] } },
      ));
      return;
    }
    if (request.headers["x-lite-internal-token"] !== options.internalToken) {
      await reply.code(401).send(errorEnvelope("unauthorized", "Invalid IPC token"));
    }
  });

  app.get("/healthz", async (): Promise<ManagerHealth> => ({
    ok: true,
    role: "manager",
    protocolVersion: LITE_IPC_PROTOCOL_VERSION,
    instanceId: options.instanceId ?? "embedded",
    uptimeSeconds: Math.floor(process.uptime()),
    rssBytes: process.memoryUsage().rss,
  }));

  app.get("/readyz", async (_request, reply): Promise<ManagerReadiness> => {
    let dependencies: Record<string, ReadinessDependency>;
    try {
      dependencies = await options.productionReadinessChecks();
    } catch {
      dependencies = { readiness: { ok: false, reason: "dependency-check-failed" } };
    }
    const ready = Object.values(dependencies).every((dependency) => dependency.ok);
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      role: "manager",
      protocolVersion: LITE_IPC_PROTOCOL_VERSION,
      dependencies,
    });
  });

  app.post<{ Params: { accountId: string }; Body: unknown }>(
    "/internal/integrations/webhook/:accountId/inbound",
    async (request, reply) => {
      if (!options.integrationRouter || !options.integrationStore || !options.webhookSecret ||
          !request.rawBody || !request.body || typeof request.body !== "object") {
        return reply.code(404).send({ error: { code: "integration_unavailable", message: "Webhook integration is not configured" } });
      }
      const secret = await options.webhookSecret(request.params.accountId);
      const signature = request.headers["x-lite-signature"];
      if (!secret || typeof signature !== "string" || !verifyHmacSha256(request.rawBody, signature, secret)) {
        return reply.code(401).send({ error: { code: "invalid_signature", message: "Webhook signature is invalid" } });
      }
      try {
        const source = request.body as Record<string, unknown>;
        const envelope = normalizeInbound({ ...source, connectorId: "webhook", accountId: request.params.accountId });
        return reply.code(202).send(await options.integrationRouter.route(envelope));
      } catch (error) {
        return reply.code(400).send({ error: { code: "invalid_envelope", message: error instanceof Error ? error.message : String(error) } });
      }
    },
  );

  app.post<{ Body: InternalStartRunRequest }>("/internal/runs", async (request, reply) => {
    const body = request.body;
    if (!Value.Check(InternalStartRunRequestSchema, body)) {
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
    const disconnected = new AbortController();
    const onAborted = () => disconnected.abort(new Error("Gateway IPC request disconnected"));
    request.raw.once("aborted", onAborted);
    request.raw.socket.once("close", onAborted);
    try {
      const events = await options.runService.waitForEvents(request.params.runId, after, waitMs, disconnected.signal);
      return reply.send({ events });
    } catch (error) {
      if (disconnected.signal.aborted) return reply;
      throw error;
    } finally {
      request.raw.off("aborted", onAborted);
      request.raw.socket.off("close", onAborted);
    }
  });

  app.get<{ Params: { runId: string } }>("/internal/runs/:runId/attempts", async (request, reply) => {
    return options.runService.getRun(request.params.runId)
      ? { attempts: options.runService.listRunAttempts(request.params.runId) }
      : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
  });

  app.get<{ Params: { runId: string } }>("/internal/runs/:runId/children", async (request, reply) => {
    return options.runService.getRun(request.params.runId)
      ? { runs: options.runService.listChildRuns(request.params.runId) }
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
      const session = options.runService.getSession(
        request.params.sessionId,
        principalFromInternalHeaders(request.headers),
      );
      return session
        ? reply.send(session)
        : reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
    },
  );

  app.post<{ Params: { runId: string }; Body: InternalPublishArtifactRequest }>(
    "/internal/runs/:runId/artifacts",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      if (!options.artifactStore || !options.readWorkspaceArtifact || !Value.Check(InternalPublishArtifactRequestSchema, request.body)) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Malformed artifact request" } });
      }
      const run = options.runService.getRun(request.params.runId);
      if (!run || !samePrincipal(run, request.body.principal)) {
        return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
      }
      const attempt = options.runService.listRunAttempts(run.id).findLast((item) => item.status === "RUNNING");
      const lease = options.runService.getWorkspaceLease(run.workspaceId, run.id);
      const hasActiveFence = () => {
        const currentRun = options.runService.getRun(run.id);
        const currentAttempt = currentRun
          ? options.runService.listRunAttempts(currentRun.id).findLast((item) => item.status === "RUNNING")
          : undefined;
        const currentLease = currentRun
          ? options.runService.getWorkspaceLease(currentRun.workspaceId, currentRun.id)
          : undefined;
        return Boolean(currentRun && samePrincipal(currentRun, request.body.principal) && attempt && lease &&
          currentAttempt?.id === attempt.id && currentLease?.fencingToken === lease.fencingToken &&
          options.runService.validateWorkspaceLease(currentLease));
      };
      if (!attempt || !lease || !hasActiveFence()) {
        return reply.code(409).send({ error: { code: "artifact_publish_requires_active_lease", message: "Artifacts can only be promoted from the actively fenced workspace" } });
      }
      const data = await options.readWorkspaceArtifact({
        runId: run.id, workspaceId: run.workspaceId, attemptId: attempt.id, fencingToken: lease.fencingToken,
        principal: request.body.principal, path: request.body.path, maxBytes: 16 * 1024 * 1024,
      });
      if (!hasActiveFence()) {
        return reply.code(409).send({ error: { code: "artifact_publish_requires_active_lease", message: "Artifacts can only be promoted from the actively fenced workspace" } });
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
    if (!Value.Check(InternalCreateAgentProfileRequestSchema, body)) {
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
    const agent = options.runService.getAgentProfile(
      request.params.agentId,
      principalFromInternalHeaders(request.headers),
    );
    return agent
      ? agent
      : reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });
  });

  app.post<{ Body: InternalCreateWorkspaceRequest }>("/internal/workspaces", async (request, reply) => {
    const body = request.body;
    if (!Value.Check(InternalCreateWorkspaceRequestSchema, body)) {
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
    const workspace = options.runService.getWorkspace(
      request.params.workspaceId,
      principalFromInternalHeaders(request.headers),
    );
    return workspace
      ? workspace
      : reply.code(404).send({ error: { code: "not_found", message: "Workspace not found" } });
  });

  app.get<{ Params: { sessionId: string } }>(
    "/internal/sessions/:sessionId/messages",
    async (request, reply) => {
      const principal = principalFromInternalHeaders(request.headers);
      const session = options.runService.getSession(request.params.sessionId, principal);
      return session
        ? reply.send({ messages: options.runService.listSessionMessages(request.params.sessionId, principal) })
        : reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
    },
  );

  return app;
}

function installExactJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = Buffer.from(body);
    try { done(null, JSON.parse(request.rawBody.toString("utf8"))); }
    catch (error) { done(error as Error); }
  });
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
