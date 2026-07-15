import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunService } from "@lite-harness/control-plane";
import type { LocalArtifactStore } from "@lite-harness/workspace";
import { buildManagerServer } from "../apps/manager/src/server.js";

const servers: Array<ReturnType<typeof buildManagerServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("authoritative boundary schemas", () => {
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
});
