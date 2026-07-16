import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
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
  PublishArtifactRequestSchema,
  type RunEvent,
  type RunRecord,
  type SessionMessageRecord,
  type SessionRecord,
  type ManagerHealth,
  type ManagerReadiness,
  errorEnvelope,
  LITE_IPC_PROTOCOL_VERSION,
  MintRunTokenRequestSchema,
  type MintRunTokenRequest,
  DEFAULT_RUN_BUDGET,
} from "@lite-harness/contracts";
import type { AccessTokenService } from "@lite-harness/auth";
import { StructuredObservability, type TraceSpan } from "@lite-harness/observability";

declare module "fastify" {
  interface FastifyRequest { rawBody?: Buffer }
}

const authenticatedPrincipals = new WeakMap<object, InternalPrincipal>();

export interface ManagerTransport {
  health(): Promise<ManagerHealth>;
  readiness(): Promise<ManagerReadiness>;
  startRun(request: InternalStartRunRequest): Promise<CreateRunResponse>;
  getRun(runId: string): Promise<RunRecord>;
  cancelRun(runId: string): Promise<RunRecord>;
  steerRun(runId: string, instruction: string): Promise<RunRecord>;
  getApproval(approvalId: string): Promise<ApprovalRecord>;
  resolveApproval(approvalId: string, approved: boolean): Promise<ApprovalRecord>;
  getEvents(runId: string, after: number, waitMs: number, signal?: AbortSignal): Promise<RunEvent[]>;
  getRunAttempts(runId: string): Promise<RunAttemptRecord[]>;
  getChildRuns(runId: string): Promise<RunRecord[]>;
  getSession(sessionId: string, principal: InternalPrincipal): Promise<SessionRecord>;
  getSessionMessages(sessionId: string, principal: InternalPrincipal): Promise<SessionMessageRecord[]>;
  publishArtifact(runId: string, request: PublishArtifactRequest, principal: InternalPrincipal): Promise<ArtifactRecord>;
  getArtifact(artifactId: string, principal: InternalPrincipal): Promise<ArtifactPayloadResponse>;
  createAgent(request: CreateAgentProfileRequest, principal: InternalPrincipal): Promise<AgentProfileRecord>;
  getAgent(agentId: string, principal: InternalPrincipal): Promise<AgentProfileRecord>;
  listAgents(principal: InternalPrincipal): Promise<AgentProfileRecord[]>;
  createWorkspace(request: CreateWorkspaceRequest, principal: InternalPrincipal): Promise<WorkspaceRecord>;
  getWorkspace(workspaceId: string, principal: InternalPrincipal): Promise<WorkspaceRecord>;
  listWorkspaces(principal: InternalPrincipal): Promise<WorkspaceRecord[]>;
  ingestWebhook(accountId: string, rawBody: Buffer, signature: string): Promise<{ duplicate: boolean; runId?: string }>;
}

export interface GatewayServerOptions {
  manager: ManagerTransport;
  accessTokens: Pick<AccessTokenService, "authenticate" | "mintRunToken" | "revoke">;
  authFailureLimit?: number;
  authFailureWindowMs?: number;
  logger?: boolean;
  observability?: StructuredObservability;
}

export function buildGatewayServer(options: GatewayServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const observability = options.observability ?? new StructuredObservability();
  const requestSpans = new WeakMap<object, TraceSpan>();
  installExactJsonBodyParser(app);
  const authFailureLimit = options.authFailureLimit ?? 20;
  const authFailureWindowMs = options.authFailureWindowMs ?? 60_000;
  if (!Number.isSafeInteger(authFailureLimit) || authFailureLimit < 1 ||
      !Number.isSafeInteger(authFailureWindowMs) || authFailureWindowMs < 1_000) {
    throw new Error("Gateway authentication rate limit must be positive and bounded");
  }
  const authFailures = new Map<string, { count: number; startedAt: number }>();

  app.addHook("preSerialization", async (_request, reply, payload) => {
    if (reply.statusCode < 400 || !payload || typeof payload !== "object" || !("error" in payload)) return payload;
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== "object") return payload;
    const record = error as Record<string, unknown>;
    if (record.version === 1) return payload;
    return errorEnvelope(
      typeof record.code === "string" ? record.code : "request_failed",
      typeof record.message === "string" ? record.message : "Request failed",
      { retryable: record.retryable === true },
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    const caught = error instanceof Error ? error : new Error("Unknown Gateway error");
    const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
    const status = typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
      ? statusCode
      : 500;
    return reply.code(status).send(errorEnvelope(
      status === 500 ? "internal_error" : "invalid_request",
      status === 500 ? "Internal service error" : caught.message,
    ));
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0];
    const span = observability.startTrace("http.request", {
      service: "gateway", method: request.method, route,
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
      service: "gateway", method: request.method, route, statusCode,
    }, span);
    observability.counter("http.requests.total", 1, {
      service: "gateway", method: request.method, route, statusCode,
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/readyz" || request.url.startsWith("/hooks/")) {
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const failureKey = request.ip;
    if (isAuthRateLimited(authFailures, failureKey, authFailureLimit, authFailureWindowMs)) {
      await reply.code(429).send(errorEnvelope("rate_limited", "Too many failed authentication attempts", {
        retryable: true,
        retryAfterMs: authFailureWindowMs,
      }));
      return;
    }
    if (!token) {
      const limited = recordAuthFailure(authFailures, failureKey, authFailureLimit, authFailureWindowMs);
      await reply.code(limited ? 429 : 401).send(errorEnvelope(
        limited ? "rate_limited" : "unauthorized",
        limited ? "Too many failed authentication attempts" : "Invalid app token",
        limited ? { retryable: true, retryAfterMs: authFailureWindowMs } : undefined,
      ));
      return;
    }
    try {
      const principal = await options.accessTokens.authenticate(token);
      if (!principal) throw new Error("Invalid app credential");
      authenticatedPrincipals.set(request, principal);
      authFailures.delete(failureKey);
    } catch {
      const limited = recordAuthFailure(authFailures, failureKey, authFailureLimit, authFailureWindowMs);
      await reply.code(limited ? 429 : 401).send(errorEnvelope(
        limited ? "rate_limited" : "unauthorized",
        limited ? "Too many failed authentication attempts" : "Invalid app token",
        limited ? { retryable: true, retryAfterMs: authFailureWindowMs } : undefined,
      ));
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    const scope = requiredScope(request.method, request.routeOptions.url);
    if (!scope) return;
    const principal = principalFromRequest(request);
    if (!principal.scopes.includes(scope)) {
      await reply.code(403).send(errorEnvelope("insufficient_scope", `Route requires scope ${scope}`));
    }
  });

  app.get("/healthz", async () => ({
    ok: true, role: "gateway", uptimeSeconds: Math.floor(process.uptime()), rssBytes: process.memoryUsage().rss,
  }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const manager = await options.manager.readiness();
      return reply.code(manager.ok ? 200 : 503).send({ ok: manager.ok, role: "gateway", dependencies: { manager } });
    } catch {
      return reply.code(503).send({
        ok: false,
        role: "gateway",
        dependencies: {
          manager: {
            ok: false,
            role: "manager",
            protocolVersion: LITE_IPC_PROTOCOL_VERSION,
            dependencies: { ipc: { ok: false, reason: "manager-readiness-unavailable" } },
          },
        },
      });
    }
  });

  app.post<{ Params: { accountId: string }; Body: unknown }>("/hooks/webhook/:accountId", async (request, reply) => {
    const signature = stringHeader(request.headers["x-lite-signature"]);
    if (!signature || !request.rawBody || !request.body || typeof request.body !== "object") {
      return reply.code(400).send({ error: { code: "invalid_webhook", message: "Webhook body and X-Lite-Signature are required" } });
    }
    try {
      return reply.code(202).send(await options.manager.ingestWebhook(request.params.accountId, request.rawBody, signature));
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
    if (idempotencyKey.length === 0 || idempotencyKey.length > 200 || /[\0\r\n]/u.test(idempotencyKey)) {
      return reply.code(400).send({
        error: { code: "invalid_idempotency_key", message: "Idempotency key is empty, too long, or contains a forbidden control character" },
      });
    }
    const principal = principalFromRequest(request);
    const effectiveBudget = { ...DEFAULT_RUN_BUDGET, ...(request.body.budget ?? {}) };
    if ((principal.agentId && principal.agentId !== request.body.agent) ||
        (principal.workspaceId && principal.workspaceId !== request.body.workspace) ||
        (principal.budgetCeiling && !budgetWithin(effectiveBudget, principal.budgetCeiling))) {
      return reply.code(403).send(errorEnvelope("token_binding_violation", "Run request exceeds its token binding"));
    }
    const response = await options.manager.startRun({
      ...request.body,
      idempotencyKey,
      principal,
    });
    return reply.code(202).send(response);
  });

  app.post<{ Body: MintRunTokenRequest }>("/v1/tokens", async (request, reply) => {
    if (!Value.Check(MintRunTokenRequestSchema, request.body)) {
      return reply.code(400).send(errorEnvelope("invalid_request", "Run-token body does not match the schema"));
    }
    try {
      return reply.code(201).send(await options.accessTokens.mintRunToken(principalFromRequest(request), request.body));
    } catch (error) {
      return reply.code(403).send(errorEnvelope(
        "token_scope_expansion",
        errorMessage(error, "Run token request was denied"),
      ));
    }
  });

  app.delete<{ Params: { tokenId: string } }>("/v1/tokens/:tokenId", async (request, reply) => {
    try {
      const revoked = options.accessTokens.revoke(principalFromRequest(request), request.params.tokenId);
      return revoked ?? reply.code(404).send(errorEnvelope("not_found", "Token not found"));
    } catch (error) {
      return reply.code(403).send(errorEnvelope(
        "token_revoke_denied",
        errorMessage(error, "Token revocation was denied"),
      ));
    }
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
    try {
      const run = await options.manager.getRun(request.params.runId);
      return ownsRun(run, principalFromRequest(request))
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
      if (!ownsRun(existing, principalFromRequest(request))) {
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
      const principal = principalFromRequest(request);
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
      const principal = principalFromRequest(request);
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
      if (startAfter === undefined) {
        return reply.code(400).send(errorEnvelope("invalid_event_cursor", "after must be a non-negative safe integer"));
      }
      try {
        const run = await options.manager.getRun(request.params.runId);
        if (!ownsRun(run, principalFromRequest(request))) {
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
      response.flushHeaders();

      let cursor = startAfter;
      let closed = false;
      const disconnected = new AbortController();
      response.once("close", () => {
        closed = true;
        disconnected.abort(new Error("SSE client disconnected"));
      });

      try {
        while (!closed) {
          const events = await options.manager.getEvents(request.params.runId, cursor, 5_000, disconnected.signal);
          for (const event of events) {
            await writeSse(response, `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, disconnected.signal);
            cursor = event.sequence;
          }
          const run = await options.manager.getRun(request.params.runId);
          if (isTerminalRunStatus(run.status) && cursor >= run.lastSequence) {
            break;
          }
          if (events.length === 0) {
            await writeSse(response, ": keepalive\n\n", disconnected.signal);
          }
        }
      } catch (error) {
        if (!closed && !disconnected.signal.aborted) {
          await writeSse(response,
            `event: stream.error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`,
            disconnected.signal,
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
    const principal = principalFromRequest(request);
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
    const principal = principalFromRequest(request);
    try {
      const run = await options.manager.getRun(request.params.runId);
      return ownsRun(run, principal)
        ? { runs: (await options.manager.getChildRuns(run.id)).filter((child) => ownsRun(child, principal)) }
        : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    } catch {
      return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      try {
        return await options.manager.getSession(request.params.sessionId, principalFromRequest(request));
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
      }
    },
  );

  app.post<{ Params: { runId: string }; Body: PublishArtifactRequest }>(
    "/v1/runs/:runId/artifacts",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request, reply) => {
      const principal = principalFromRequest(request);
      try {
        const run = await options.manager.getRun(request.params.runId);
        if (!ownsRun(run, principal)) return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
        if (!Value.Check(PublishArtifactRequestSchema, request.body)) return reply.code(400).send({ error: { code: "invalid_request", message: "Malformed artifact request" } });
        return reply.code(201).send(await options.manager.publishArtifact(run.id, request.body, principal));
      } catch (error) {
        return reply.code(400).send({ error: { code: "artifact_publish_failed", message: error instanceof Error ? error.message : String(error) } });
      }
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/v1/artifacts/:artifactId",
    async (request, reply) => {
      const principal = principalFromRequest(request);
      try {
        const payload = await options.manager.getArtifact(request.params.artifactId, principal);
        const run = await options.manager.getRun(payload.record.runId);
        return ownsRun(run, principal)
          ? payload
          : reply.code(404).send({ error: { code: "not_found", message: "Artifact not found" } });
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Artifact not found" } });
      }
    },
  );

  app.post<{ Body: CreateAgentProfileRequest }>("/v1/agents", async (request, reply) => {
    if (!Value.Check(CreateAgentProfileRequestSchema, request.body)) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Agent body does not match the schema" } });
    }
    return reply.code(201).send(await options.manager.createAgent(request.body, principalFromRequest(request)));
  });

  app.get("/v1/agents", async (request) => ({
    agents: await options.manager.listAgents(principalFromRequest(request)),
  }));

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request, reply) => {
    try { return await options.manager.getAgent(request.params.agentId, principalFromRequest(request)); }
    catch { return reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } }); }
  });

  app.post<{ Body: CreateWorkspaceRequest }>("/v1/workspaces", async (request, reply) => {
    if (!Value.Check(CreateWorkspaceRequestSchema, request.body ?? {})) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Workspace body does not match the schema" } });
    }
    return reply.code(201).send(await options.manager.createWorkspace(request.body ?? {}, principalFromRequest(request)));
  });

  app.get("/v1/workspaces", async (request) => ({
    workspaces: await options.manager.listWorkspaces(principalFromRequest(request)),
  }));

  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId", async (request, reply) => {
    try { return await options.manager.getWorkspace(request.params.workspaceId, principalFromRequest(request)); }
    catch { return reply.code(404).send({ error: { code: "not_found", message: "Workspace not found" } }); }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      try {
        const principal = principalFromRequest(request);
        await options.manager.getSession(request.params.sessionId, principal);
        return { messages: await options.manager.getSessionMessages(request.params.sessionId, principal) };
      } catch {
        return reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
      }
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

function principalFromRequest(request: FastifyRequest): InternalPrincipal {
  const principal = authenticatedPrincipals.get(request);
  if (!principal) throw new Error("Authenticated principal is unavailable");
  return principal;
}

function stringHeader(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function writeSse(response: ServerResponse, frame: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed || response.writableEnded) throw new Error("SSE response is closed");
  if (!response.write(frame)) await awaitSseDrain(response, signal);
}

export function awaitSseDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed || response.writableEnded) throw new Error("SSE response closed before drain");
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("SSE response closed before drain")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("SSE drain aborted"));
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function parseCursor(value: string | undefined): number | undefined {
  if (value === undefined) {
    return 0;
  }
  if (!/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7);
  return token.length >= 16 && token.length <= 4_096 && !/[\r\n\0]/.test(token) ? token : undefined;
}

function isAuthRateLimited(
  failures: Map<string, { count: number; startedAt: number }>,
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const current = failures.get(key);
  if (!current) return false;
  if (Date.now() - current.startedAt >= windowMs) {
    failures.delete(key);
    return false;
  }
  return current.count >= limit;
}

function recordAuthFailure(
  failures: Map<string, { count: number; startedAt: number }>,
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const current = failures.get(key);
  const next = !current || now - current.startedAt >= windowMs
    ? { count: 1, startedAt: now }
    : { count: current.count + 1, startedAt: current.startedAt };
  failures.set(key, next);
  return next.count >= limit;
}

function requiredScope(method: string, route: string | undefined): string | undefined {
  if (!route?.startsWith("/v1/")) return undefined;
  const key = `${method.toUpperCase()} ${route}`;
  const scopes: Record<string, string> = {
    "POST /v1/tokens": "tokens:mint",
    "DELETE /v1/tokens/:tokenId": "tokens:revoke",
    "POST /v1/runs": "runs:create",
    "GET /v1/runs/:runId": "runs:read",
    "POST /v1/runs/:runId/cancel": "runs:cancel",
    "POST /v1/runs/:runId/steer": "runs:steer",
    "GET /v1/runs/:runId/events": "events:read",
    "GET /v1/runs/:runId/attempts": "runs:read",
    "GET /v1/runs/:runId/children": "runs:read",
    "POST /v1/approvals/:approvalId": "approvals:resolve",
    "GET /v1/sessions/:sessionId": "sessions:read",
    "GET /v1/sessions/:sessionId/messages": "sessions:read",
    "POST /v1/runs/:runId/artifacts": "artifacts:publish",
    "GET /v1/artifacts/:artifactId": "artifacts:read",
    "POST /v1/agents": "agents:write",
    "GET /v1/agents": "agents:read",
    "GET /v1/agents/:agentId": "agents:read",
    "POST /v1/workspaces": "workspaces:write",
    "GET /v1/workspaces": "workspaces:read",
    "GET /v1/workspaces/:workspaceId": "workspaces:read",
  };
  return scopes[key] ?? "route:unconfigured";
}

function budgetWithin(requested: Record<string, number>, ceiling: Record<string, number>): boolean {
  return Object.entries(requested).every(([key, value]) => ceiling[key] === undefined || value <= ceiling[key]);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function ownsRun(
  run: { appId: string; tenantId: string; userId: string; agentId?: string; workspaceId?: string },
  principal: InternalPrincipal,
): boolean {
  return (
    run.appId === principal.appId &&
    run.tenantId === principal.tenantId &&
    run.userId === principal.userId &&
    (!principal.agentId || run.agentId === principal.agentId) &&
    (!principal.workspaceId || run.workspaceId === principal.workspaceId)
  );
}
