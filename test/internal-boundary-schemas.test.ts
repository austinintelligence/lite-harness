import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunService } from "@lite-harness/control-plane";
import { LocalArtifactStore } from "@lite-harness/workspace";
import { buildManagerServer } from "../apps/manager/src/server.js";

const servers: Array<ReturnType<typeof buildManagerServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("authoritative boundary schemas", () => {
  it("D06 confines production Gateway-to-Manager traffic to versioned schema-bound local IPC", () => {
    const gatewayManifest = JSON.parse(readFileSync(resolve("apps/gateway/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(gatewayManifest.dependencies ?? {})).not.toEqual(expect.arrayContaining([
      "@lite-harness/agent-runtime",
      "@lite-harness/control-plane",
      "@lite-harness/storage-sqlite",
    ]));

    const gatewayMain = readFileSync(resolve("apps/gateway/src/main.ts"), "utf8");
    expect(gatewayMain.match(/new ManagerClient\(socketPath, internalToken\)/g)).toHaveLength(1);
    expect(gatewayMain).not.toMatch(/apps[\\/]manager|@lite-harness\/(?:agent-runtime|control-plane|storage-sqlite)/);

    const client = readFileSync(resolve("apps/gateway/src/manager-client.ts"), "utf8");
    expect(client).toContain("socketPath: this.socketPath");
    expect(client).toContain("[LITE_IPC_VERSION_HEADER]: LITE_IPC_PROTOCOL_VERSION");
    expect(client).not.toMatch(/\b(?:hostname|host|port)\s*:/);

    const manager = readFileSync(resolve("apps/manager/src/server.ts"), "utf8");
    for (const schema of [
      "InternalStartRunRequestSchema",
      "InternalPublishArtifactRequestSchema",
      "InternalCreateAgentProfileRequestSchema",
      "InternalCreateWorkspaceRequestSchema",
    ]) {
      expect(manager).toContain(`Value.Check(${schema}`);
    }
    expect(manager).toContain("LITE_IPC_PROTOCOL_VERSION");
  });

  it("BD-037-REGRESSION rejects malformed and extra fields at internal and public contracts", async () => {
    const createRun = vi.fn(() => ({ runId: "run-schema", status: "ACCEPTED", eventCursor: 0, idempotentReplay: false }));
    const runService = { createRun } as unknown as RunService;
    const server = buildManagerServer({
      runService,
      internalToken: "internal-schema-token",
      artifactStore: {} as LocalArtifactStore,
      productionReadinessChecks: async () => ({}),
    });
    servers.push(server);
    const headers = { "x-lite-internal-token": "internal-schema-token", "x-lite-ipc-version": "1" };
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] };
    const invalid = [
      ["/internal/runs", { agent: "coder", workspace: "workspace", input: "go", idempotencyKey: "key", principal, unexpected: true }],
      ["/internal/runs/run-schema/artifacts", { path: "report.txt", mediaType: "text/plain", dataBase64: "***", principal }],
      ["/internal/agents", { name: "agent", principal, unexpected: true }],
      ["/internal/workspaces", { mode: "registered-bind", principal }],
    ] as const;
    for (const [url, payload] of invalid) {
      const response = await server.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode, url).toBe(400);
    }
    expect(createRun).not.toHaveBeenCalled();

    const valid = await server.inject({
      method: "POST", url: "/internal/runs", headers,
      payload: { agent: "coder", workspace: "workspace", input: "go", idempotencyKey: "key", principal },
    });
    expect(valid.statusCode).toBe(202);
    expect(createRun).toHaveBeenCalledOnce();

  });

  it("lists runs only for the principal supplied on the versioned internal boundary", async () => {
    const listRuns = vi.fn((principal: { appId: string; tenantId: string; userId: string }, limit: number) => [{
      id: "run-owner", appId: principal.appId, tenantId: principal.tenantId, userId: principal.userId, limit,
    }]);
    const server = buildManagerServer({
      runService: { listRuns } as unknown as RunService,
      internalToken: "internal-run-list-token",
      productionReadinessChecks: async () => ({}),
    });
    servers.push(server);
    const response = await server.inject({
      method: "GET",
      url: "/internal/runs?limit=7",
      headers: {
        "x-lite-internal-token": "internal-run-list-token",
        "x-lite-ipc-version": "1",
        "x-lite-app-id": "app-owner",
        "x-lite-tenant-id": "tenant-owner",
        "x-lite-user-id": "user-owner",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      runs: [{ id: "run-owner", appId: "app-owner", tenantId: "tenant-owner", userId: "user-owner", limit: 7 }],
      limit: 7,
    });
    expect(listRuns).toHaveBeenCalledWith(
      { appId: "app-owner", tenantId: "tenant-owner", userId: "user-owner", scopes: [] },
      7,
    );
  });

  it("deletes only an owner-scoped agent through the internal CLI boundary", async () => {
    const deleteAgentProfile = vi.fn(() => true);
    const server = buildManagerServer({
      runService: { deleteAgentProfile } as unknown as RunService,
      internalToken: "internal-agent-delete-token",
      productionReadinessChecks: async () => ({}),
    });
    servers.push(server);
    const response = await server.inject({
      method: "DELETE", url: "/internal/agents/agent-one",
      headers: {
        "x-lite-internal-token": "internal-agent-delete-token",
        "x-lite-ipc-version": "1",
        "x-lite-app-id": "app-one",
        "x-lite-tenant-id": "tenant-one",
        "x-lite-user-id": "user-one",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: true, agentId: "agent-one" });
    expect(deleteAgentProfile).toHaveBeenCalledWith(
      "agent-one", { appId: "app-one", tenantId: "tenant-one", userId: "user-one", scopes: [] },
    );
  });

  it("BD-035-REGRESSION rejects caller bytes and promotes only a reader-owned workspace path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-artifact-boundary-"));
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["artifacts:publish"] };
    const run = { id: "run-artifact", workspaceId: "workspace-artifact", appId: principal.appId, tenantId: principal.tenantId, userId: principal.userId };
    const lease = { workspaceId: run.workspaceId, ownerRunId: run.id, fencingToken: 7, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const reader = vi.fn(async () => Buffer.from("managed workspace bytes"));
    const runService = {
      getRun: () => run,
      listRunAttempts: () => [{ id: "attempt-artifact", status: "RUNNING" }],
      getWorkspaceLease: () => lease,
      validateWorkspaceLease: () => true,
    } as unknown as RunService;
    const artifactStore = new LocalArtifactStore(join(directory, "artifacts"), Buffer.alloc(32, 8));
    const server = buildManagerServer({
      runService,
      internalToken: "internal-artifact-token",
      artifactStore,
      readWorkspaceArtifact: reader,
      productionReadinessChecks: async () => ({}),
    });
    servers.push(server);
    const headers = { "x-lite-internal-token": "internal-artifact-token", "x-lite-ipc-version": "1" };
    const valid = await server.inject({
      method: "POST", url: `/internal/runs/${run.id}/artifacts`, headers,
      payload: { path: "reports/result.txt", mediaType: "text/plain", principal },
    });
    expect(valid.statusCode).toBe(201);
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id, attemptId: "attempt-artifact", fencingToken: 7, path: "reports/result.txt", maxBytes: 16 * 1024 * 1024,
    }));
    const record = valid.json<{ id: string; sizeBytes: number }>();
    expect(record.sizeBytes).toBe(Buffer.byteLength("managed workspace bytes"));
    expect(artifactStore.get(record.id, principal)?.data.toString()).toBe("managed workspace bytes");
    const forged = await server.inject({
      method: "POST", url: `/internal/runs/${run.id}/artifacts`, headers,
      payload: { path: "reports/forged.txt", mediaType: "text/plain", dataBase64: Buffer.from("forged").toString("base64"), principal },
    });
    expect(forged.statusCode).toBe(400);
    rmSync(directory, { recursive: true, force: true });
  });

  it("BD-035-REGRESSION rejects promotion when the workspace fence changes during the read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-artifact-fence-"));
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["artifacts:publish"] };
    const run = { id: "run-artifact-fence", workspaceId: "workspace-artifact-fence", appId: principal.appId, tenantId: principal.tenantId, userId: principal.userId };
    let lease = { workspaceId: run.workspaceId, ownerRunId: run.id, fencingToken: 7, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const reader = vi.fn(async () => {
      lease = { ...lease, fencingToken: 8 };
      return Buffer.from("read after lease replacement");
    });
    const runService = {
      getRun: () => run,
      listRunAttempts: () => [{ id: "attempt-artifact-fence", status: "RUNNING" }],
      getWorkspaceLease: () => lease,
      validateWorkspaceLease: (candidate: typeof lease) => candidate.fencingToken === lease.fencingToken,
    } as unknown as RunService;
    const artifactStore = new LocalArtifactStore(join(directory, "artifacts"), Buffer.alloc(32, 8));
    const server = buildManagerServer({
      runService,
      internalToken: "internal-artifact-fence-token",
      artifactStore,
      readWorkspaceArtifact: reader,
      productionReadinessChecks: async () => ({}),
    });
    servers.push(server);
    const response = await server.inject({
      method: "POST", url: `/internal/runs/${run.id}/artifacts`,
      headers: { "x-lite-internal-token": "internal-artifact-fence-token", "x-lite-ipc-version": "1" },
      payload: { path: "reports/result.txt", mediaType: "text/plain", principal },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "artifact_publish_requires_active_lease" } });
    expect(reader).toHaveBeenCalledOnce();
    rmSync(directory, { recursive: true, force: true });
  });
});
