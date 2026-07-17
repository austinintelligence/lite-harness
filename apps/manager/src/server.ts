import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { Value } from "@sinclair/typebox/value";
import type {
  ArtifactPayloadResponse,
  InternalPrincipal,
  InternalPublishArtifactRequest,
  InternalStartRunRequest,
  InternalCreateAgentProfileRequest,
  InternalCreateWorkspaceRequest,
  InternalCreateProviderConnectionRequest,
  InternalProviderConnectionLoginRequest,
  ModelCatalogRecord,
  ProviderConnectionRecord,
  WorkspaceRecord,
  ManagerHealth,
  ManagerReadiness,
  ReadinessDependency,
} from "@lite-harness/contracts";
import {
  DEFAULT_RUN_BUDGET,
  InternalCreateAgentProfileRequestSchema,
  InternalCreateWorkspaceRequestSchema,
  InternalCreateProviderConnectionRequestSchema,
  InternalProviderConnectionLoginRequestSchema,
  InternalPublishArtifactRequestSchema,
  InternalStartRunRequestSchema,
  LITE_IPC_PROTOCOL_VERSION,
  LITE_IPC_VERSION_HEADER,
  errorEnvelope,
} from "@lite-harness/contracts";
import { randomUUID } from "node:crypto";
import { RunService } from "@lite-harness/control-plane";
import { StructuredObservability, type TraceSpan } from "@lite-harness/observability";
import type { LocalArtifactStore, SnapshotRecord } from "@lite-harness/workspace";
import type { InboundRunRouter, SqliteIntegrationStore } from "@lite-harness/integrations";
import { normalizeInbound, verifyHmacSha256 } from "@lite-harness/integrations";
import type { PluginPermissions } from "@lite-harness/plugin-core";
import type { PluginLifecyclePort } from "./plugin-lifecycle.js";

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
  pluginLifecycle?: PluginLifecyclePort;
  modelCatalog?: (principal: InternalPrincipal) => ModelCatalogRecord[] | Promise<ModelCatalogRecord[]>;
  providerConnectionLogin?: (connection: ProviderConnectionRecord, secret: string) => Promise<void>;
  providerConnectionLogout?: (connection: ProviderConnectionRecord) => Promise<void>;
  workspaceAdmin?: ManagerWorkspaceAdmin;
  productionReadinessChecks: () => Promise<Record<string, ReadinessDependency>>;
}

export interface ManagerWorkspaceAdmin {
  registerWorkspace(params: {
    id: string;
    principal: InternalPrincipal;
    registeredPath: string;
  }): WorkspaceRecord;
  exportWorkspace(params: { workspaceId: string; principal: InternalPrincipal }): Promise<Buffer>;
  importWorkspace(params: { workspaceId: string; principal: InternalPrincipal; archive: Buffer }): Promise<void>;
  snapshotWorkspace(params: { workspaceId: string; principal: InternalPrincipal }): Promise<SnapshotRecord>;
  restoreWorkspace(params: { workspaceId: string; principal: InternalPrincipal }): Promise<{ recoveredFromPrevious: boolean }>;
  deleteWorkspace(params: { workspaceId: string; principal: InternalPrincipal }): Promise<boolean>;
  exportWorkspaceToPath?(params: { workspaceId: string; principal: InternalPrincipal; path: string }): Promise<{ path: string; bytes: number }>;
  importWorkspaceFromPath?(params: { workspaceId: string; principal: InternalPrincipal; path: string }): Promise<{ path: string; bytes: number }>;
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

  if (options.pluginLifecycle) {
    const plugins = options.pluginLifecycle;
    app.get("/internal/plugins", async () => plugins.status());
    app.post<{ Body: unknown }>("/internal/plugins/inspect", async (request, reply) => {
      try { return plugins.inspect(pluginStringField(request.body, "path")); }
      catch (error) { return pluginFailure(reply, error); }
    });
    app.post<{ Body: unknown }>("/internal/plugins/install", async (request, reply) => {
      try {
        return await plugins.install(
          pluginStringField(request.body, "sourceRoot"),
          pluginGrantField(request.body),
        );
      } catch (error) { return pluginFailure(reply, error); }
    });
    app.post<{ Params: { id: string; version: string } }>(
      "/internal/plugins/:id/:version/enable",
      async (request, reply) => {
        try { return await plugins.enable(request.params.id, request.params.version); }
        catch (error) { return pluginFailure(reply, error); }
      },
    );
    app.post<{ Params: { id: string }; Body: unknown }>("/internal/plugins/:id/upgrade", async (request, reply) => {
      try {
        return await plugins.upgrade(
          request.params.id,
          pluginStringField(request.body, "sourceRoot"),
          pluginGrantField(request.body),
        );
      } catch (error) { return pluginFailure(reply, error); }
    });
    app.post<{ Params: { id: string } }>("/internal/plugins/:id/rollback", async (request, reply) => {
      try { return await plugins.rollback(request.params.id); }
      catch (error) { return pluginFailure(reply, error); }
    });
    app.post<{ Params: { id: string } }>("/internal/plugins/:id/disable", async (request, reply) => {
      try { return await plugins.disable(request.params.id); }
      catch (error) { return pluginFailure(reply, error); }
    });
    app.post<{ Params: { id: string; version: string } }>("/internal/plugins/:id/:version/disable", async (request, reply) => {
      try { return await plugins.disable(request.params.id, request.params.version); }
      catch (error) { return pluginFailure(reply, error); }
    });
    app.delete<{ Params: { id: string; version: string } }>("/internal/plugins/:id/:version", async (request, reply) => {
      try { return { removed: await plugins.uninstall(request.params.id, request.params.version) }; }
      catch (error) { return pluginFailure(reply, error); }
    });
  }

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
    const principal = requireInternalPrincipal(request.headers);
    if (!samePrincipal(body.principal, principal)) {
      return reply.code(403).send(errorEnvelope("owner_mismatch", "The request principal does not match the authenticated IPC owner"));
    }
    return reply.code(202).send(options.runService.createRun({ ...body, principal }));
  });

  app.get<{ Querystring: { limit?: string } }>("/internal/runs", async (request) => {
    const principal = requireInternalPrincipal(request.headers);
    const limit = boundedInteger(request.query.limit, 1, 1_000, 100);
    return { runs: options.runService.listRuns(principal, limit), limit };
  });

  app.get<{ Params: { runId: string } }>("/internal/runs/:runId", async (request, reply) => {
    const principal = requireInternalPrincipal(request.headers);
    const run = options.runService.getRun(request.params.runId);
    return run && samePrincipal(run, principal)
      ? reply.send(run)
      : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
  });

  app.get<{
    Params: { runId: string };
    Querystring: { after?: string; wait_ms?: string };
  }>("/internal/runs/:runId/events", async (request, reply) => {
    const principal = requireInternalPrincipal(request.headers);
    const run = options.runService.getRun(request.params.runId);
    if (!run || !samePrincipal(run, principal)) {
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
    const principal = requireInternalPrincipal(request.headers);
    const run = options.runService.getRun(request.params.runId);
    return run && samePrincipal(run, principal)
      ? { attempts: options.runService.listRunAttempts(request.params.runId) }
      : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
  });

  app.get<{ Params: { runId: string } }>("/internal/runs/:runId/children", async (request, reply) => {
    const principal = requireInternalPrincipal(request.headers);
    const run = options.runService.getRun(request.params.runId);
    return run && samePrincipal(run, principal)
      ? { runs: options.runService.listChildRuns(request.params.runId) }
      : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
  });

  app.post<{ Params: { runId: string } }>(
    "/internal/runs/:runId/cancel",
    async (request, reply) => {
      const principal = requireInternalPrincipal(request.headers);
      const existing = options.runService.getRun(request.params.runId);
      if (!existing || !samePrincipal(existing, principal)) {
        return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
      }
      const run = options.runService.cancelRun(request.params.runId);
      return run
        ? reply.send(run)
        : reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    },
  );

  app.post<{ Params: { runId: string }; Body: { instruction?: string } }>(
    "/internal/runs/:runId/steer",
    async (request, reply) => {
      const principal = requireInternalPrincipal(request.headers);
      const existing = options.runService.getRun(request.params.runId);
      if (!existing || !samePrincipal(existing, principal)) {
        return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
      }
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
      const run = approval ? options.runService.getRun(approval.runId) : undefined;
      const principal = requireInternalPrincipal(request.headers);
      return approval && run && samePrincipal(run, principal)
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
      const principal = requireInternalPrincipal(request.headers);
      const existing = options.runService.getApproval(request.params.approvalId);
      const run = existing ? options.runService.getRun(existing.runId) : undefined;
      if (!existing || !run || !samePrincipal(run, principal)) {
        return reply.code(404).send({ error: { code: "not_found", message: "Approval not found" } });
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
      const principal = requireInternalPrincipal(request.headers);
      const session = options.runService.getSession(
        request.params.sessionId,
        principal,
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
      const authenticatedPrincipal = requireInternalPrincipal(request.headers);
      if (!samePrincipal(request.body.principal, authenticatedPrincipal)) {
        return reply.code(403).send(errorEnvelope("owner_mismatch", "The artifact principal does not match the authenticated IPC owner"));
      }
      const run = options.runService.getRun(request.params.runId);
      if (!run || !samePrincipal(run, authenticatedPrincipal)) {
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
        return Boolean(currentRun && samePrincipal(currentRun, authenticatedPrincipal) && attempt && lease &&
          currentAttempt?.id === attempt.id && currentLease?.fencingToken === lease.fencingToken &&
          options.runService.validateWorkspaceLease(currentLease));
      };
      if (!attempt || !lease || !hasActiveFence()) {
        return reply.code(409).send({ error: { code: "artifact_publish_requires_active_lease", message: "Artifacts can only be promoted from the actively fenced workspace" } });
      }
      const data = await options.readWorkspaceArtifact({
        runId: run.id, workspaceId: run.workspaceId, attemptId: attempt.id, fencingToken: lease.fencingToken,
        principal: authenticatedPrincipal, path: request.body.path, maxBytes: 16 * 1024 * 1024,
      });
      if (!hasActiveFence()) {
        return reply.code(409).send({ error: { code: "artifact_publish_requires_active_lease", message: "Artifacts can only be promoted from the actively fenced workspace" } });
      }
      const record = options.artifactStore.publish({
        runId: run.id,
        workspaceId: run.workspaceId,
        principal: authenticatedPrincipal,
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
      const principal = requireInternalPrincipal(request.headers);
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
    const principal = requireInternalPrincipal(request.headers);
    if (!samePrincipal(body.principal, principal)) return reply.code(403).send(errorEnvelope("owner_mismatch", "The agent principal does not match the authenticated IPC owner"));
    const now = new Date().toISOString();
    return reply.code(201).send(options.runService.createAgentProfile({
      id: body.id ?? `agt_${randomUUID().replaceAll("-", "")}`,
      version: 1,
      appId: principal.appId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      name: body.name,
      instructions: body.instructions ?? "",
      modelCapabilities: body.modelCapabilities ?? ["text", "tools"],
      allowedTools: body.allowedTools ?? ["read_file", "write_file"],
      defaultBudget: { ...DEFAULT_RUN_BUDGET, ...(body.defaultBudget ?? {}) },
      createdAt: now,
    }));
  });

  app.get("/internal/agents", async (request) => ({
    agents: options.runService.listAgentProfiles(requireInternalPrincipal(request.headers)),
  }));

  app.get<{ Params: { agentId: string } }>("/internal/agents/:agentId", async (request, reply) => {
    const agent = options.runService.getAgentProfile(
      request.params.agentId,
      requireInternalPrincipal(request.headers),
    );
    return agent
      ? agent
      : reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });
  });

  app.delete<{ Params: { agentId: string } }>("/internal/agents/:agentId", async (request, reply) => {
    const deleted = options.runService.deleteAgentProfile(
      request.params.agentId,
      requireInternalPrincipal(request.headers),
    );
    return deleted
      ? { deleted: true, agentId: request.params.agentId }
      : reply.code(409).send({ error: { code: "resource_in_use_or_missing", message: "Agent is missing or still referenced by a run/session" } });
  });

  app.post<{ Body: InternalCreateWorkspaceRequest }>("/internal/workspaces", async (request, reply) => {
    const body = request.body;
    if (!Value.Check(InternalCreateWorkspaceRequestSchema, body)) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Only managed public workspaces are supported" } });
    }
    const principal = requireInternalPrincipal(request.headers);
    if (!samePrincipal(body.principal, principal)) return reply.code(403).send(errorEnvelope("owner_mismatch", "The workspace principal does not match the authenticated IPC owner"));
    const now = new Date().toISOString();
    return reply.code(201).send(options.runService.createWorkspace({
      id: body.id ?? `wsp_${randomUUID().replaceAll("-", "")}`,
      appId: principal.appId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      mode: "managed",
      state: "WARM",
      createdAt: now,
      updatedAt: now,
    }));
  });

  app.get("/internal/workspaces", async (request) => ({
    workspaces: options.runService.listWorkspaces(requireInternalPrincipal(request.headers)),
  }));

  app.get<{ Params: { workspaceId: string } }>("/internal/workspaces/:workspaceId", async (request, reply) => {
    const workspace = options.runService.getWorkspace(
      request.params.workspaceId,
      requireInternalPrincipal(request.headers),
    );
    return workspace
      ? workspace
      : reply.code(404).send({ error: { code: "not_found", message: "Workspace not found" } });
  });

  app.post<{ Params: { workspaceId: string }; Body: unknown }>("/internal/workspaces/:workspaceId/register", async (request, reply) => {
    if (!options.workspaceAdmin) return reply.code(503).send(errorEnvelope("workspace_admin_unavailable", "Workspace administration is unavailable"));
    const body = objectBody(request.body, "workspace register request");
    const registeredPath = boundedPath(body.registeredPath, "registeredPath");
    const principal = requireInternalPrincipal(request.headers);
    return reply.code(201).send(options.workspaceAdmin.registerWorkspace({
      id: request.params.workspaceId,
      principal,
      registeredPath,
    }));
  });

  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/internal/workspaces/:workspaceId/export",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      if (!options.workspaceAdmin) return reply.code(503).send(errorEnvelope("workspace_admin_unavailable", "Workspace administration is unavailable"));
      const body = objectBody(request.body, "workspace export request");
      const principal = requireInternalPrincipal(request.headers);
      const path = optionalBoundedPath(body.path, "path");
      if (path !== undefined) {
        if (!options.workspaceAdmin.exportWorkspaceToPath) return reply.code(503).send(errorEnvelope("workspace_archive_path_unavailable", "Manager archive path export is unavailable"));
        return reply.send(await options.workspaceAdmin.exportWorkspaceToPath({ workspaceId: request.params.workspaceId, principal, path }));
      }
      const archive = await options.workspaceAdmin.exportWorkspace({ workspaceId: request.params.workspaceId, principal });
      if (archive.length > 8 * 1024 * 1024) return reply.code(413).send(errorEnvelope("workspace_archive_requires_path", "Large workspace exports require an archive path"));
      return reply.send({ workspaceId: request.params.workspaceId, archiveBase64: archive.toString("base64"), bytes: archive.length });
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/internal/workspaces/:workspaceId/import",
    { bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      if (!options.workspaceAdmin) return reply.code(503).send(errorEnvelope("workspace_admin_unavailable", "Workspace administration is unavailable"));
      const body = objectBody(request.body, "workspace import request");
      const principal = requireInternalPrincipal(request.headers);
      const path = optionalBoundedPath(body.path, "path");
      if (path !== undefined) {
        if (!options.workspaceAdmin.importWorkspaceFromPath) return reply.code(503).send(errorEnvelope("workspace_archive_path_unavailable", "Manager archive path import is unavailable"));
        return reply.send(await options.workspaceAdmin.importWorkspaceFromPath({ workspaceId: request.params.workspaceId, principal, path }));
      }
      const archiveBase64 = boundedBase64(body.archiveBase64, "archiveBase64");
      const archive = Buffer.from(archiveBase64, "base64");
      return reply.send(await options.workspaceAdmin.importWorkspace({ workspaceId: request.params.workspaceId, principal, archive }).then(() => ({
        workspaceId: request.params.workspaceId,
        imported: true,
        bytes: archive.length,
      })));
    },
  );

  app.post<{ Params: { workspaceId: string } }>("/internal/workspaces/:workspaceId/snapshot", async (request, reply) => {
    if (!options.workspaceAdmin) return reply.code(503).send(errorEnvelope("workspace_admin_unavailable", "Workspace administration is unavailable"));
    return reply.send(await options.workspaceAdmin.snapshotWorkspace({
      workspaceId: request.params.workspaceId,
      principal: requireInternalPrincipal(request.headers),
    }));
  });

  app.post<{ Params: { workspaceId: string } }>("/internal/workspaces/:workspaceId/restore", async (request, reply) => {
    if (!options.workspaceAdmin) return reply.code(503).send(errorEnvelope("workspace_admin_unavailable", "Workspace administration is unavailable"));
    return reply.send(await options.workspaceAdmin.restoreWorkspace({
      workspaceId: request.params.workspaceId,
      principal: requireInternalPrincipal(request.headers),
    }));
  });

  app.delete<{ Params: { workspaceId: string } }>("/internal/workspaces/:workspaceId", async (request, reply) => {
    if (!options.workspaceAdmin) return reply.code(503).send(errorEnvelope("workspace_admin_unavailable", "Workspace administration is unavailable"));
    return reply.send({
      workspaceId: request.params.workspaceId,
      removed: await options.workspaceAdmin.deleteWorkspace({
        workspaceId: request.params.workspaceId,
        principal: requireInternalPrincipal(request.headers),
      }),
    });
  });

  app.get("/internal/models", async (request) => ({
    models: await options.modelCatalog?.(requireInternalPrincipal(request.headers)) ?? [],
  }));

  app.get("/internal/provider-connections", async (request) => ({
    connections: options.runService.listProviderConnections(requireInternalPrincipal(request.headers)),
  }));

  app.post<{ Body: InternalCreateProviderConnectionRequest }>(
    "/internal/provider-connections",
    async (request, reply) => {
      const body = request.body;
      if (!Value.Check(InternalCreateProviderConnectionRequestSchema, body)) {
        return reply.code(400).send(errorEnvelope("invalid_request", "Provider connection metadata does not match the schema"));
      }
      const principal = requireInternalPrincipal(request.headers);
      if (!samePrincipal(body.principal, principal)) return reply.code(403).send(errorEnvelope("owner_mismatch", "The provider connection principal does not match the authenticated IPC owner"));
      try {
        validateProviderConnectionEndpoint(body.baseUrl);
      } catch (error) {
        return reply.code(400).send(errorEnvelope("invalid_provider_endpoint", error instanceof Error ? error.message : String(error)));
      }
      const now = new Date().toISOString();
      try {
        return reply.code(201).send(options.runService.createProviderConnection({
          id: body.id ?? `pc_${randomUUID().replaceAll("-", "")}`,
          appId: principal.appId,
          tenantId: principal.tenantId,
          userId: principal.userId,
          providerId: body.providerId,
          displayName: body.displayName,
          authKind: body.authKind ?? "api_key",
          credentialProfileId: `cred_${randomUUID().replaceAll("-", "")}`,
          ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
          modelIds: body.modelIds ?? [],
          status: "needs_login",
          createdAt: now,
          updatedAt: now,
        }));
      } catch (error) {
        return reply.code(409).send(errorEnvelope("provider_connection_conflict", error instanceof Error ? error.message : String(error)));
      }
    },
  );

  app.post<{ Params: { connectionId: string }; Body: InternalProviderConnectionLoginRequest }>(
    "/internal/provider-connections/:connectionId/login",
    async (request, reply) => {
      const body = request.body;
      if (!Value.Check(InternalProviderConnectionLoginRequestSchema, body)) {
        return reply.code(400).send(errorEnvelope("invalid_request", "Provider login payload does not match the schema"));
      }
      const owner = requireInternalPrincipal(request.headers);
      if (!samePrincipal(body.principal, owner)) return reply.code(403).send(errorEnvelope("owner_mismatch", "The provider login principal does not match the authenticated IPC owner"));
      const connection = options.runService.getProviderConnection(request.params.connectionId, owner);
      if (!connection) return reply.code(404).send(errorEnvelope("not_found", "Provider connection not found"));
      if (!options.providerConnectionLogin) {
        return reply.code(503).send(errorEnvelope("provider_login_unavailable", "This Manager has no credential broker login handler", { retryable: true }));
      }
      try {
        await options.providerConnectionLogin(connection, body.secret);
        return reply.send(options.runService.updateProviderConnection(connection.id, owner, { status: "ready" }));
      } catch (error) {
        const code = error instanceof Error && /^[A-Za-z0-9_.-]{1,128}$/u.test(error.message) ? error.message : "provider_login_failed";
        const updated = options.runService.updateProviderConnection(connection.id, owner, { status: "error", lastErrorCode: code });
        return reply.code(502).send(errorEnvelope("provider_login_failed", "Provider credential could not be stored", {
          retryable: true,
          details: { status: updated?.status ?? "error", errorCode: code },
        }));
      }
    },
  );

  app.delete<{ Params: { connectionId: string } }>(
    "/internal/provider-connections/:connectionId",
    async (request, reply) => {
      const owner = requireInternalPrincipal(request.headers);
      const connection = options.runService.getProviderConnection(request.params.connectionId, owner);
      if (!connection) return reply.code(404).send(errorEnvelope("not_found", "Provider connection not found"));
      try {
        await options.providerConnectionLogout?.(connection);
        const deleted = options.runService.deleteProviderConnection(connection.id, owner);
        return deleted
          ? { deleted: true, connectionId: connection.id }
          : reply.code(404).send(errorEnvelope("not_found", "Provider connection not found"));
      } catch (error) {
        return reply.code(409).send(errorEnvelope("provider_connection_delete_failed", error instanceof Error ? error.message : String(error), { retryable: true }));
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/internal/sessions/:sessionId/messages",
    async (request, reply) => {
      const principal = requireInternalPrincipal(request.headers);
      const session = options.runService.getSession(request.params.sessionId, principal);
      return session
        ? reply.send({ messages: options.runService.listSessionMessages(request.params.sessionId, principal) })
        : reply.code(404).send({ error: { code: "not_found", message: "Session not found" } });
    },
  );

  return app;
}

function pluginStringField(body: unknown, field: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Plugin request body must be an object");
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim() || value.length > 32_768 || /[\0\r\n]/.test(value)) {
    throw new Error(`Plugin request ${field} must be a bounded single-line string`);
  }
  return value;
}

function validateProviderConnectionEndpoint(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  const parsed = new URL(baseUrl);
  if (parsed.username || parsed.password) throw new Error("Provider endpoint must not contain URL credentials");
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error("Provider endpoint must use HTTPS unless it is loopback");
  }
}

function pluginGrantField(body: unknown): Partial<PluginPermissions> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Plugin request body must be an object");
  const grant = (body as Record<string, unknown>).grant;
  if (grant === undefined) return {};
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) throw new Error("Plugin grant must be an object");
  const allowed = new Set(["tools", "secrets", "events", "files", "networkOrigins"]);
  const result: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(grant)) {
    if (!allowed.has(key) || !Array.isArray(value) || value.length > 256 ||
        !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4_096 && !/[\0\r\n]/.test(item))) {
      throw new Error(`Plugin grant ${key} must be a bounded string array`);
    }
    result[key] = [...new Set(value as string[])];
  }
  return result;
}

function pluginFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(409).send(errorEnvelope("plugin_lifecycle_conflict", message));
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

function requireInternalPrincipal(headers: Record<string, unknown>): InternalPrincipal {
  const principal = principalFromInternalHeaders(headers);
  if (!principal.appId || !principal.tenantId || !principal.userId) throw new Error("Owner headers are required for Manager IPC operations");
  return principal;
}

function objectBody(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || /[\0\r\n]/u.test(value)) throw new Error(`${label} must be a bounded path`);
  return value.trim();
}

function optionalBoundedPath(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedPath(value, label);
}

function boundedBase64(value: unknown, label: string): string {
  const encoded = boundedPath(value, label);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) throw new Error(`${label} must be valid base64`);
  return encoded;
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
