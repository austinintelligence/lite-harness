import { afterEach, describe, expect, it } from "vitest";
import { LiteHarnessClient } from "@lite-harness/sdk";
import { buildGatewayServer, type ManagerTransport } from "../apps/gateway/src/server.js";
import type { InternalPrincipal, RunEvent, RunRecord } from "@lite-harness/contracts";

const principal: InternalPrincipal = {
  appId: "app-replay",
  tenantId: "tenant-replay",
  userId: "user-replay",
  scopes: ["events:read", "runs:read"],
  tokenType: "app",
};

const servers: Array<ReturnType<typeof buildGatewayServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    if (server.server.listening) await server.close();
  }
});

describe("SDK reconnect and replay", () => {
  it("A03-RECONNECT-REPLAY resumes after a real Gateway restart without gaps, duplicates, or run re-execution", async () => {
    const runId = "run-replay";
    const events = [
      event(runId, 1, "run.accepted"),
      event(runId, 2, "run.started"),
      event(runId, 3, "run.succeeded"),
    ];
    let restarted = false;
    let terminal = false;
    let startRunCalls = 0;
    const requestedCursors: number[] = [];
    const manager = {
      health: async () => ({
        ok: true as const,
        role: "manager" as const,
        protocolVersion: "1" as const,
        instanceId: "manager-stays-alive",
        uptimeSeconds: 1,
        rssBytes: 1,
      }),
      startRun: async () => {
        startRunCalls += 1;
        throw new Error("The SDK event path must never re-execute a run");
      },
      getRun: async () => runRecord(runId, terminal ? "SUCCEEDED" : "RUNNING", terminal ? 3 : 1),
      getEvents: async (_runId: string, after: number) => {
        requestedCursors.push(after);
        if (after === 0) return [events[0]];
        if (!restarted) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return [];
        }
        // Deliberately repeat the cursor event to prove the SDK de-duplicates replay frames.
        return after === 1 ? events : events.filter((item) => item.sequence > after);
      },
    } as unknown as ManagerTransport;
    const accessTokens = {
      authenticate: async (token: string) => token === "replay-token-fixture" ? principal : undefined,
      mintRunToken: async () => { throw new Error("not used"); },
      revoke: () => undefined,
    };

    const firstGateway = buildGatewayServer({ manager, accessTokens });
    servers.push(firstGateway);
    const firstAddress = await firstGateway.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(firstAddress).port);
    const client = new LiteHarnessClient({ baseUrl: firstAddress, token: "replay-token-fixture" });

    let receivedFirst!: () => void;
    const firstReceived = new Promise<void>((resolve) => { receivedFirst = resolve; });
    const received: number[] = [];
    const consume = (async () => {
      for await (const item of client.events(runId, 0, { reconnectDelayMs: 10 })) {
        received.push(item.sequence);
        if (item.sequence === 1) receivedFirst();
        if (item.sequence === 3) break;
      }
    })();

    await firstReceived;
    firstGateway.server.closeAllConnections();
    await firstGateway.close();

    restarted = true;
    terminal = true;
    const secondGateway = buildGatewayServer({ manager, accessTokens });
    servers.push(secondGateway);
    await secondGateway.listen({ host: "127.0.0.1", port });
    await consume;

    expect(received).toEqual([1, 2, 3]);
    expect(requestedCursors).toContain(1);
    expect(startRunCalls).toBe(0);
  });
});

function event(runId: string, sequence: number, type: RunEvent["type"]): RunEvent {
  return { runId, sequence, type, payload: {}, createdAt: new Date(sequence).toISOString() };
}

function runRecord(runId: string, status: RunRecord["status"], lastSequence: number): RunRecord {
  const now = new Date().toISOString();
  return {
    id: runId,
    idempotencyKey: "replay-key",
    appId: principal.appId,
    tenantId: principal.tenantId,
    userId: principal.userId,
    agentId: "agent-replay",
    workspaceId: "workspace-replay",
    depth: 0,
    deliveryAllowed: true,
    input: "continue",
    budget: {
      maxTurns: 8,
      maxToolCalls: 32,
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCostUsd: 1,
      totalTimeoutMs: 60_000,
      modelIdleTimeoutMs: 10_000,
      commandTimeoutMs: 10_000,
    },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 },
    status,
    lastSequence,
    createdAt: now,
    updatedAt: now,
  };
}
