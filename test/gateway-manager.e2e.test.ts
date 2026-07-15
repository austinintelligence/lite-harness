import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { LocalArtifactStore } from "@lite-harness/workspace";
import { InboundRunRouter, SqliteIntegrationStore } from "@lite-harness/integrations";
import { buildGatewayServer } from "../apps/gateway/src/server.js";
import type { ManagerTransport } from "../apps/gateway/src/server.js";
import { buildManagerServer } from "../apps/manager/src/server.js";
import type { InternalPrincipal, MintRunTokenRequest } from "@lite-harness/contracts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) {
    await action();
  }
});

describe("Gateway to Manager vertical slice", () => {
  it("creates an idempotent durable run through local IPC and streams its events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-harness-test-"));
    const internalToken = "internal-test-token";
    const appToken = "app-test-token-primary";
    const otherAppToken = "app-test-token-secondary";
    const mintedPrincipals = new Map<string, InternalPrincipal>();
    const store = new SqliteRunStore(join(directory, "test.db"));
    const runtime = new InMemoryToolRuntime();
    const artifactStore = new LocalArtifactStore(join(directory, "artifacts"), Buffer.alloc(32, 3));
    const service = new RunService(store, new AgentRunner(new FakeModelGateway(), runtime));
    const integrationStore = new SqliteIntegrationStore(join(directory, "integrations.db"));
    integrationStore.bind({
      connectorId: "webhook", accountId: "primary", senderExternalId: "*",
      appId: "app_local", tenantId: "tenant-a", userId: "user-a", agentId: "coder",
      workspaceId: "webhook-workspace", sessionPrefix: "hook",
    });
    const integrationRouter = new InboundRunRouter(integrationStore, async ({ binding, envelope, sessionId }) => service.createRun({
      agent: binding.agentId, workspace: binding.workspaceId, session: sessionId, input: envelope.text,
      idempotencyKey: `webhook:${envelope.accountId}:${envelope.deliveryId}`,
      principal: { appId: binding.appId, tenantId: binding.tenantId, userId: binding.userId, scopes: ["runs:create"] },
    }).runId);
    const manager = buildManagerServer({
      runService: service, internalToken, artifactStore, integrationStore, integrationRouter,
      productionReadinessChecks: async () => ({ embedded: { ok: true } }),
      webhookSecret: async (accountId) => accountId === "primary" ? Buffer.from("webhook-secret") : undefined,
    });
    const accessTokens = {
      authenticate: async (token: string): Promise<InternalPrincipal | undefined> => {
        const minted = mintedPrincipals.get(token);
        if (minted) return minted;
        if (token !== appToken && token !== otherAppToken) return undefined;
        return {
          appId: "app_local",
          tenantId: token === appToken ? "tenant-a" : "tenant-b",
          userId: "user-a",
          scopes: [
            "tokens:mint", "tokens:revoke", "runs:create", "runs:read", "runs:cancel", "runs:steer", "events:read",
            "approvals:resolve", "sessions:read", "artifacts:publish", "artifacts:read",
            "agents:write", "agents:read", "workspaces:write", "workspaces:read",
          ],
          tokenType: "app" as const,
        };
      },
      mintRunToken: async (principal: InternalPrincipal, request: MintRunTokenRequest) => {
        const token = `lhr_fixture-token-${mintedPrincipals.size}`;
        const tokenId = `tok_fixture_${mintedPrincipals.size}`;
        mintedPrincipals.set(token, {
          ...principal,
          tokenId,
          tokenType: "run",
          scopes: request.scopes,
          ...(request.agentId ? { agentId: request.agentId } : {}),
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          ...(request.budgetCeiling ? { budgetCeiling: request.budgetCeiling } : {}),
        });
        return {
          token,
          tokenId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          scopes: request.scopes,
          replayPolicy: "resource_bound_multi_use" as const,
        };
      },
      revoke: (principal: InternalPrincipal, tokenId: string) => {
        const entry = [...mintedPrincipals.entries()].find(([, value]) => value.tokenId === tokenId);
        if (!entry || entry[1].appId !== principal.appId || entry[1].tenantId !== principal.tenantId ||
            entry[1].userId !== principal.userId) return undefined;
        mintedPrincipals.delete(entry[0]);
        return { tokenId, revoked: true as const };
      },
    };
    const managerTransport: ManagerTransport = {
      health: async () => ({
        ok: true,
        role: "manager",
        protocolVersion: "1",
        instanceId: "embedded-test",
        uptimeSeconds: 1,
        rssBytes: process.memoryUsage().rss,
      }),
      readiness: async () => ({
        ok: true,
        role: "manager",
        protocolVersion: "1",
        dependencies: { embedded: { ok: true } },
      }),
      startRun: async (request) => service.createRun(request),
      getRun: async (runId) => {
        const run = service.getRun(runId);
        if (!run) throw new Error("Run not found");
        return run;
      },
      cancelRun: async (runId) => {
        const run = service.cancelRun(runId);
        if (!run) throw new Error("Run not found");
        return run;
      },
      steerRun: async (runId, instruction) => service.steerRun(runId, instruction),
      getApproval: async (approvalId) => {
        const approval = service.getApproval(approvalId);
        if (!approval) throw new Error("Approval not found");
        return approval;
      },
      resolveApproval: async (approvalId, approved) => {
        const approval = service.resolveApproval(approvalId, approved);
        if (!approval) throw new Error("Approval not found");
        return approval;
      },
      getEvents: (runId, after, waitMs) => service.waitForEvents(runId, after, waitMs),
      getRunAttempts: async (runId) => service.listRunAttempts(runId),
      getChildRuns: async (runId) => service.listChildRuns(runId),
      getSession: async (sessionId, principal) => {
        const session = service.getSession(sessionId, principal);
        if (!session) throw new Error("Session not found");
        return session;
      },
      getSessionMessages: async (sessionId, principal) => service.listSessionMessages(sessionId, principal),
      publishArtifact: async (runId, request, principal) => {
        const run = service.getRun(runId);
        if (!run) throw new Error("Run not found");
        return artifactStore.publish({
          runId,
          workspaceId: run.workspaceId,
          principal,
          path: request.path,
          mediaType: request.mediaType,
          data: Buffer.from(request.dataBase64, "base64"),
        });
      },
      getArtifact: async (artifactId, principal) => {
        const payload = artifactStore.get(artifactId, principal);
        if (!payload) throw new Error("Artifact not found");
        return { record: payload.record, dataBase64: payload.data.toString("base64") };
      },
      createAgent: async (request, principal) => service.createAgentProfile({
        id: request.id ?? "agt-test",
        version: 1,
        appId: principal.appId,
        tenantId: principal.tenantId,
        userId: principal.userId,
        name: request.name,
        instructions: request.instructions ?? "",
        modelCapabilities: request.modelCapabilities ?? ["text", "tools"],
        allowedTools: request.allowedTools ?? ["read_file", "write_file"],
        defaultBudget: {
          maxTurns: 8, maxToolCalls: 32, maxInputTokens: 250_000, maxOutputTokens: 64_000,
          maxCostUsd: 25, totalTimeoutMs: 900_000, modelIdleTimeoutMs: 120_000, commandTimeoutMs: 300_000,
          ...(request.defaultBudget ?? {}),
        },
        createdAt: new Date().toISOString(),
      }),
      getAgent: async (agentId, principal) => {
        const agent = service.getAgentProfile(agentId, principal);
        if (!agent) throw new Error("Agent not found");
        return agent;
      },
      listAgents: async (principal) => service.listAgentProfiles(principal),
      createWorkspace: async (request, principal) => {
        const now = new Date().toISOString();
        return service.createWorkspace({
          id: request.id ?? "wsp-test", appId: principal.appId, tenantId: principal.tenantId,
          userId: principal.userId, mode: "managed", state: "WARM", createdAt: now, updatedAt: now,
        });
      },
      getWorkspace: async (workspaceId, principal) => {
        const workspace = service.getWorkspace(workspaceId, principal);
        if (!workspace) throw new Error("Workspace not found");
        return workspace;
      },
      listWorkspaces: async (principal) => service.listWorkspaces(principal),
      ingestWebhook: async (accountId, rawBody, signature) => {
        const response = await manager.inject({
          method: "POST", url: `/internal/integrations/webhook/${accountId}/inbound`,
          headers: {
            "x-lite-internal-token": internalToken,
            "x-lite-ipc-version": "1",
            "x-lite-signature": signature,
            "content-type": "application/json",
          },
          payload: rawBody,
        });
        if (response.statusCode >= 400) throw new Error(response.body);
        return response.json<{ duplicate: boolean; runId?: string }>();
      },
    };
    const gateway = buildGatewayServer({ manager: managerTransport, accessTokens });

    cleanup.push(async () => {
      await gateway.close();
      await manager.close();
      store.close();
      integrationStore.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const readiness = await gateway.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ ok: true, dependencies: { manager: { ok: true, role: "manager" } } });

    const create = () =>
      gateway.inject({
        method: "POST",
        url: "/v1/runs",
        headers: {
          authorization: `Bearer ${appToken}`,
          "content-type": "application/json",
          "idempotency-key": "same-request",
          "x-lite-tenant-id": "tenant-a",
          "x-lite-user-id": "user-a",
        },
        payload: {
          agent: "coder",
          workspace: "workspace-a",
          input: "write the first vertical slice",
        },
      });

    const first = await create();
    expect(first.statusCode).toBe(202);
    const firstBody = first.json<{ runId: string; idempotentReplay: boolean }>();
    const terminal = await service.waitForTerminal(firstBody.runId);
    expect(terminal.status).toBe("SUCCEEDED");
    expect(runtime.readFile("workspace-a", "hello.txt", {
      appId: "app_local", tenantId: "tenant-a", userId: "user-a", scopes: [],
    })).toContain("first vertical slice");
    expect((await managerTransport.getRunAttempts(firstBody.runId))).toMatchObject([
      { attempt: 1, status: "SUCCEEDED" },
    ]);
    expect(terminal.sessionId).toMatch(/^ses_/);

    const messages = await gateway.inject({
      method: "GET",
      url: `/v1/sessions/${terminal.sessionId}/messages`,
      headers: {
        authorization: `Bearer ${appToken}`,
        "x-lite-tenant-id": "tenant-a",
        "x-lite-user-id": "user-a",
      },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json<{ messages: Array<{ role: string }> }>().messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const second = await create();
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ runId: firstBody.runId, idempotentReplay: true });

    const stream = await gateway.inject({
      method: "GET",
      url: `/v1/runs/${firstBody.runId}/events?after=0`,
      headers: {
        authorization: `Bearer ${appToken}`,
        "x-lite-tenant-id": "tenant-a",
        "x-lite-user-id": "user-a",
      },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("event: run.accepted");
    expect(stream.body).toContain("event: tool.call.completed");
    expect(stream.body).toContain("event: run.succeeded");

    const spoofedTenantHeader = await gateway.inject({
      method: "GET",
      url: `/v1/runs/${firstBody.runId}`,
      headers: {
        authorization: `Bearer ${appToken}`,
        "x-lite-tenant-id": "tenant-b",
        "x-lite-user-id": "user-a",
      },
    });
    expect(spoofedTenantHeader.statusCode).toBe(200);
    const hiddenFromOtherTenant = await gateway.inject({
      method: "GET",
      url: `/v1/runs/${firstBody.runId}`,
      headers: { authorization: `Bearer ${otherAppToken}` },
    });
    expect(hiddenFromOtherTenant.statusCode).toBe(404);

    const mintLimited = await gateway.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { authorization: `Bearer ${appToken}` },
      payload: {
        scopes: ["runs:create"],
        agentId: "coder",
        workspaceId: "workspace-a",
        budgetCeiling: { maxTurns: 2 },
      },
    });
    expect(mintLimited.statusCode).toBe(201);
    const limitedToken = mintLimited.json<{ token: string }>().token;
    expect((await gateway.inject({
      method: "GET",
      url: `/v1/runs/${firstBody.runId}`,
      headers: { authorization: `Bearer ${limitedToken}` },
    })).statusCode).toBe(403);
    expect((await gateway.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${limitedToken}` },
      payload: { agent: "coder", workspace: "other-workspace", input: "must fail", budget: { maxTurns: 2 } },
    })).statusCode).toBe(403);
    expect((await gateway.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${limitedToken}` },
      payload: { agent: "coder", workspace: "workspace-a", input: "must exceed default ceiling" },
    })).statusCode).toBe(403);
    const boundCreate = await gateway.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${limitedToken}`, "idempotency-key": "bound-run" },
      payload: { agent: "coder", workspace: "workspace-a", input: "bounded run", budget: { maxTurns: 2 } },
    });
    expect(boundCreate.statusCode).toBe(202);
    await expect(service.waitForTerminal(boundCreate.json<{ runId: string }>().runId)).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect((await gateway.inject({
      method: "DELETE",
      url: `/v1/tokens/${mintLimited.json<{ tokenId: string }>().tokenId}`,
      headers: { authorization: `Bearer ${appToken}` },
    })).statusCode).toBe(200);
    expect((await gateway.inject({
      method: "GET",
      url: `/v1/runs/${firstBody.runId}`,
      headers: { authorization: `Bearer ${limitedToken}` },
    })).statusCode).toBe(401);

    const incompatibleIpc = await manager.inject({
      method: "GET",
      url: `/internal/runs/${firstBody.runId}`,
      headers: { "x-lite-ipc-version": "0" },
    });
    expect(incompatibleIpc.statusCode).toBe(426);
    expect(incompatibleIpc.json()).toMatchObject({
      error: { version: 1, code: "ipc_version_mismatch", retryable: false },
    });
    const unauthenticatedIpc = await manager.inject({
      method: "GET",
      url: `/internal/runs/${firstBody.runId}`,
      headers: { "x-lite-ipc-version": "1" },
    });
    expect(unauthenticatedIpc.statusCode).toBe(401);
    const authenticatedIpc = await manager.inject({
      method: "GET",
      url: `/internal/runs/${firstBody.runId}`,
      headers: { "x-lite-internal-token": internalToken, "x-lite-ipc-version": "1" },
    });
    expect(authenticatedIpc.statusCode).toBe(200);

    const artifact = await gateway.inject({
      method: "POST",
      url: `/v1/runs/${firstBody.runId}/artifacts`,
      headers: {
        authorization: `Bearer ${appToken}`,
        "x-lite-tenant-id": "tenant-a",
        "x-lite-user-id": "user-a",
        "content-type": "application/json",
      },
      payload: {
        path: "output/result.txt",
        mediaType: "text/plain",
        dataBase64: Buffer.from("owned result").toString("base64"),
      },
    });
    expect(artifact.statusCode).toBe(201);
    const malformedArtifact = await gateway.inject({
      method: "POST", url: `/v1/runs/${firstBody.runId}/artifacts`,
      headers: {
        authorization: `Bearer ${appToken}`,
        "x-lite-tenant-id": "tenant-a",
        "x-lite-user-id": "user-a",
        "content-type": "application/json",
      },
      payload: { path: "output/invalid.txt", mediaType: "text/plain", dataBase64: "***", unexpected: true },
    });
    expect(malformedArtifact.statusCode).toBe(400);
    const artifactId = artifact.json<{ id: string }>().id;
    const download = await gateway.inject({
      method: "GET",
      url: `/v1/artifacts/${artifactId}`,
      headers: {
        authorization: `Bearer ${appToken}`,
        "x-lite-tenant-id": "tenant-a",
        "x-lite-user-id": "user-a",
      },
    });
    expect(Buffer.from(download.json<{ dataBase64: string }>().dataBase64, "base64").toString()).toBe("owned result");
    const crossTenantDownload = await gateway.inject({
      method: "GET",
      url: `/v1/artifacts/${artifactId}`,
      headers: {
        authorization: `Bearer ${otherAppToken}`,
        "x-lite-tenant-id": "tenant-b",
        "x-lite-user-id": "user-a",
      },
    });
    expect(crossTenantDownload.statusCode).toBe(404);

    const createdAgent = await gateway.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${appToken}`, "x-lite-tenant-id": "tenant-a", "x-lite-user-id": "user-a" },
      payload: { id: "agent-explicit", name: "Explicit agent", allowedTools: ["read_file"] },
    });
    expect(createdAgent.statusCode).toBe(201);
    const createdWorkspace = await gateway.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${appToken}`, "x-lite-tenant-id": "tenant-a", "x-lite-user-id": "user-a" },
      payload: { id: "workspace-explicit" },
    });
    expect(createdWorkspace.statusCode).toBe(201);
    expect((await gateway.inject({
      method: "GET", url: "/v1/agents",
      headers: { authorization: `Bearer ${appToken}`, "x-lite-tenant-id": "tenant-a", "x-lite-user-id": "user-a" },
    })).json<{ agents: unknown[] }>().agents.length).toBeGreaterThanOrEqual(2);

    const webhookEnvelope = {
      deliveryId: "hook-delivery", senderExternalId: "sender", conversationExternalId: "thread", text: "from webhook",
    };
    const webhookSignature = `sha256=${createHmac("sha256", "webhook-secret").update(JSON.stringify(webhookEnvelope)).digest("hex")}`;
    const webhook = await gateway.inject({
      method: "POST", url: "/hooks/webhook/primary",
      headers: { "x-lite-signature": webhookSignature }, payload: webhookEnvelope,
    });
    expect(webhook.statusCode).toBe(202);
    const webhookRunId = webhook.json<{ runId: string }>().runId;
    await expect(service.waitForTerminal(webhookRunId)).resolves.toMatchObject({ status: "SUCCEEDED" });
    const replayedWebhook = await gateway.inject({
      method: "POST", url: "/hooks/webhook/primary",
      headers: { "x-lite-signature": webhookSignature }, payload: webhookEnvelope,
    });
    expect(replayedWebhook.json()).toMatchObject({ duplicate: true, runId: webhookRunId });

    const whitespaceEnvelope = {
      deliveryId: "hook-raw-bytes", senderExternalId: "sender", conversationExternalId: "thread", text: "exact bytes",
    };
    const rawWebhook = Buffer.from(`{\n  "deliveryId": "hook-raw-bytes",\n  "senderExternalId": "sender",\n  "conversationExternalId": "thread",\n  "text": "exact bytes"\n}`);
    const canonicalOnlySignature = `sha256=${createHmac("sha256", "webhook-secret").update(JSON.stringify(whitespaceEnvelope)).digest("hex")}`;
    const rejectedReserialization = await gateway.inject({
      method: "POST", url: "/hooks/webhook/primary",
      headers: { "x-lite-signature": canonicalOnlySignature, "content-type": "application/json" }, payload: rawWebhook,
    });
    expect(rejectedReserialization.statusCode).toBe(401);
    const exactSignature = `sha256=${createHmac("sha256", "webhook-secret").update(rawWebhook).digest("hex")}`;
    const exactWebhook = await gateway.inject({
      method: "POST", url: "/hooks/webhook/primary",
      headers: { "x-lite-signature": exactSignature, "content-type": "application/json" }, payload: rawWebhook,
    });
    expect(exactWebhook.statusCode).toBe(202);
    await expect(service.waitForTerminal(exactWebhook.json<{ runId: string }>().runId)).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("rejects unauthenticated public requests", async () => {
    const fakeManager = {
      startRun: async () => {
        throw new Error("must not be called");
      },
    } as unknown as ManagerTransport;
    const gateway = buildGatewayServer({ manager: fakeManager, accessTokens: rejectingAccessTokens() });
    cleanup.push(() => gateway.close());
    const response = await gateway.inject({ method: "GET", url: "/v1/runs/missing" });
    expect(response.statusCode).toBe(401);
  });

  it("rate-limits repeated public authentication failures", async () => {
    const fakeManager = {} as unknown as ManagerTransport;
    const gateway = buildGatewayServer({
      manager: fakeManager,
      accessTokens: rejectingAccessTokens(),
      authFailureLimit: 2,
      authFailureWindowMs: 60_000,
    });
    cleanup.push(() => gateway.close());
    expect((await gateway.inject({
      method: "GET", url: "/v1/runs/missing", headers: { authorization: "Bearer invalid-token-value" },
    })).statusCode).toBe(401);
    const limited = await gateway.inject({
      method: "GET", url: "/v1/runs/missing", headers: { authorization: "Bearer invalid-token-value" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { version: 1, code: "rate_limited", retryable: true } });
  });
});

function rejectingAccessTokens() {
  return {
    authenticate: async () => undefined,
    mintRunToken: async () => { throw new Error("must not be called"); },
    revoke: () => undefined,
  };
}
