import { describe, expect, it } from "vitest";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { buildGatewayServer, type ManagerTransport } from "../apps/gateway/src/server.js";
import type { InternalPrincipal, ProviderConnectionRecord } from "@lite-harness/contracts";
import { ConnectionAwareModelGateway, type ModelGateway, type ModelRunContext } from "@lite-harness/provider-core";

const owner = { appId: "app", tenantId: "tenant", userId: "owner" };
const otherOwner = { appId: "app", tenantId: "tenant", userId: "other" };

describe("owner-scoped provider connections", () => {
  it("persists opaque credential references and never crosses owner boundaries", () => {
    const store = new SqliteRunStore(":memory:");
    const record = connection({ ...owner, id: "shared", credentialProfileId: "cred_owner" });
    expect(store.createProviderConnection(record)).toEqual(record);
    expect(store.listProviderConnections(owner)).toEqual([record]);
    expect(store.listProviderConnections(otherOwner)).toEqual([]);
    expect(store.getProviderConnection("shared", otherOwner)).toBeUndefined();
    expect(store.updateProviderConnection("shared", owner, { status: "ready" })).toMatchObject({ status: "ready" });
    const created = store.createOrGetRun("run_provider", {
      agent: "coder", workspace: "provider-workspace", input: "use the selected connection",
      providerConnectionId: "shared", idempotencyKey: "provider-run",
      principal: { ...owner, scopes: ["runs:create"] },
    });
    expect(created.run.providerConnectionId).toBe("shared");
    expect(store.deleteProviderConnection("shared", otherOwner)).toBe(false);
    expect(store.deleteProviderConnection("shared", owner)).toBe(true);
    store.close();
  });

  it("fails closed when a selected connection cannot be resolved instead of falling back", async () => {
    const fallback: ModelGateway = { streamTurn: async function* () { yield { type: "text.delta", delta: "fallback" }; } };
    const selected: ModelGateway = { streamTurn: async function* () { yield { type: "text.delta", delta: "selected" }; } };
    const gateway = new ConnectionAwareModelGateway(fallback, async (connectionId) => connectionId === "owner-connection" ? selected : undefined);
    const context: ModelRunContext = {
      runId: "run", attemptId: "attempt", workspaceId: "workspace",
      principal: { ...owner, scopes: ["runs:create"] }, fencingToken: 1,
      providerConnectionId: "owner-connection",
    };
    const selectedEvents = [];
    for await (const event of gateway.streamTurn({ messages: [{ role: "user", content: "hello" }], context })) selectedEvents.push(event);
    expect(selectedEvents).toEqual([{ type: "text.delta", delta: "selected" }]);
    const missing = { ...context, runId: "missing", providerConnectionId: "missing-connection" };
    await expect((async () => {
      for await (const _event of gateway.streamTurn({ messages: [{ role: "user", content: "hello" }], context: missing })) { /* consume */ }
    })()).rejects.toMatchObject({ code: "provider_connection_unavailable" });
  });

  it("exposes the redacted catalog and owner-scoped provider API through authenticated Gateway calls", async () => {
    const calls: { principal?: InternalPrincipal; secret?: string } = {};
    const created = connection({ ...owner, id: "public", credentialProfileId: "cred_public" });
    const manager = {
      listModels: async (principal: InternalPrincipal) => {
        calls.principal = principal;
        return [{ id: "gpt-5.6-luna", providerId: "hermes", capabilities: ["text", "tools"], contextWindow: 128_000, provenance: "operator" as const }];
      },
      listProviderConnections: async () => [created],
      createProviderConnection: async () => created,
      loginProviderConnection: async (_id: string, request: { secret: string }) => {
        calls.secret = request.secret;
        return { ...created, status: "ready" as const };
      },
      deleteProviderConnection: async (id: string) => ({ deleted: true as const, connectionId: id }),
    } as unknown as ManagerTransport;
    const app = buildGatewayServer({
      manager,
      accessTokens: {
        authenticate: async (token: string) => token === "app-token-123456" ? {
          ...owner,
          scopes: ["models:read", "providers:read", "providers:write"],
          tokenType: "app" as const,
          replayPolicy: "multi_use" as const,
        } : undefined,
        mintRunToken: async () => { throw new Error("unused"); },
        revoke: () => undefined,
      },
    });
    await app.ready();
    const headers = { authorization: "Bearer app-token-123456" };
    expect((await app.inject({ method: "GET", url: "/v1/models", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/provider-connections", headers })).json()).toEqual({ connections: [created] });
    expect((await app.inject({
      method: "POST", url: "/v1/provider-connections/public/login", headers,
      payload: { secret: "placeholder-secret-123" },
    })).statusCode).toBe(200);
    expect(calls.principal?.userId).toBe("owner");
    expect(calls.secret).toBe("placeholder-secret-123");
    expect((await app.inject({ method: "DELETE", url: "/v1/provider-connections/public", headers })).json()).toEqual({
      deleted: true, connectionId: "public",
    });
    await app.close();
  });
});

function connection(ownerFields: { appId: string; tenantId: string; userId: string; id: string; credentialProfileId: string }): ProviderConnectionRecord {
  const now = "2026-07-17T00:00:00.000Z";
  return {
    id: ownerFields.id,
    appId: ownerFields.appId,
    tenantId: ownerFields.tenantId,
    userId: ownerFields.userId,
    providerId: "openai-compatible",
    displayName: "Local Hermes",
    authKind: "local_endpoint",
    credentialProfileId: ownerFields.credentialProfileId,
    baseUrl: "http://127.0.0.1:8645/v1",
    modelIds: ["gpt-5.6-luna"],
    status: "needs_login",
    createdAt: now,
    updatedAt: now,
  };
}
