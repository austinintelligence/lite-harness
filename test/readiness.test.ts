import { describe, expect, it } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import type { InternalPrincipal } from "@lite-harness/contracts";
import { RunService } from "@lite-harness/control-plane";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { buildGatewayServer, type ManagerTransport } from "../apps/gateway/src/server.js";
import { buildManagerServer } from "../apps/manager/src/server.js";

const principal: InternalPrincipal = {
  appId: "app-ready", tenantId: "tenant-ready", userId: "user-ready",
  scopes: ["runs:read"], tokenType: "app",
};

describe("production readiness", () => {
  it("BD-023-REGRESSION reports each failed production dependency and keeps liveness separate", async () => {
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(store, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()));
    const manager = buildManagerServer({
      runService: service,
      internalToken: "internal-readiness-token",
      productionReadinessChecks: async () => ({
        database: store.readiness(),
        disk: { ok: true },
        runtime: { ok: false, reason: "docker-unavailable" },
        image: { ok: false, reason: "runtime-image-unavailable" },
        provider: { ok: false, reason: "provider-credential-missing" },
        snapshotKey: { ok: false, reason: "snapshot-key-missing" },
      }),
    });
    try {
      const headers = { "x-lite-internal-token": "internal-readiness-token", "x-lite-ipc-version": "1" };
      const health = await manager.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, role: "manager" });

      const readiness = await manager.inject({ method: "GET", url: "/readyz", headers });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({
        ok: false,
        role: "manager",
        dependencies: {
          database: { ok: true },
          runtime: { ok: false, reason: "docker-unavailable" },
          image: { ok: false, reason: "runtime-image-unavailable" },
          provider: { ok: false, reason: "provider-credential-missing" },
          snapshotKey: { ok: false, reason: "snapshot-key-missing" },
        },
      });
    } finally {
      await manager.close();
      store.close();
    }
  });

  it("propagates an unhealthy Manager readiness report through the public Gateway", async () => {
    const manager = {
      readiness: async () => ({
        ok: false as const,
        role: "manager" as const,
        protocolVersion: "1" as const,
        dependencies: { image: { ok: false, reason: "runtime-image-unavailable" } },
      }),
    } as unknown as ManagerTransport;
    const gateway = buildGatewayServer({
      manager,
      accessTokens: {
        authenticate: async (token) => token === "readiness-token-fixture" ? principal : undefined,
        mintRunToken: async () => { throw new Error("not used"); },
        revoke: () => undefined,
      },
    });
    try {
      const readiness = await gateway.inject({ method: "GET", url: "/readyz" });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({
        ok: false,
        dependencies: { manager: { ok: false, dependencies: { image: { ok: false } } } },
      });
    } finally {
      await gateway.close();
    }
  });

  it("requires the exact pinned Docker image to exist", async () => {
    const runtime = new DockerToolRuntime({
      image: `sha256:${"d".repeat(64)}`,
      commandRunner: async (args) => args[0] === "image"
        ? { code: 1, stdout: "", stderr: "No such image" }
        : { code: 0, stdout: "", stderr: "" },
    });
    await expect(runtime.imageReadiness()).resolves.toEqual({
      ok: false, error: "Pinned runtime image is unavailable",
    });
  });
});
