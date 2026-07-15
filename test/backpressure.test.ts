import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InternalPrincipal, RunEvent, RunRecord } from "@lite-harness/contracts";
import { boundedEventBatch } from "@lite-harness/control-plane";
import { ManagerClient } from "../apps/gateway/src/manager-client.js";
import { awaitSseDrain, buildGatewayServer, type ManagerTransport } from "../apps/gateway/src/server.js";

const cleanup: Array<() => Promise<void> | void> = [];
const principal: InternalPrincipal = {
  appId: "app-backpressure", tenantId: "tenant-backpressure", userId: "user-backpressure",
  scopes: ["events:read", "runs:read"], tokenType: "app",
};

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("SSE and local IPC flow control", () => {
  it("BD-022-REGRESSION waits for SSE drain and bounds cursor pages without dropping the next sequence", async () => {
    const emitter = new EventEmitter() as EventEmitter & { destroyed: boolean; writableEnded: boolean };
    emitter.destroyed = false;
    emitter.writableEnded = false;
    const draining = awaitSseDrain(emitter as unknown as ServerResponse, new AbortController().signal);
    emitter.emit("drain");
    await expect(draining).resolves.toBeUndefined();

    const first = event(1, "a".repeat(64));
    const second = event(2, "b".repeat(64));
    const oneEventLimit = Buffer.byteLength('{"events":[]}') + Buffer.byteLength(JSON.stringify(first));
    expect(boundedEventBatch([first, second], oneEventLimit).map((item) => item.sequence)).toEqual([1]);
    expect(() => boundedEventBatch([event(3, "too large")], 8)).toThrow(/exceeds the IPC event page limit/);
  });

  it("propagates public SSE disconnects into the active Manager long poll", async () => {
    let notifyPolling!: () => void;
    let notifyAborted!: () => void;
    const polling = new Promise<void>((resolve) => { notifyPolling = resolve; });
    const aborted = new Promise<void>((resolve) => { notifyAborted = resolve; });
    const manager = {
      getRun: async () => runRecord(),
      getEvents: async (_runId: string, _after: number, _waitMs: number, signal?: AbortSignal) => {
        notifyPolling();
        return await new Promise<RunEvent[]>((_, reject) => {
          const onAbort = () => {
            notifyAborted();
            reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      },
    } as unknown as ManagerTransport;
    const gateway = buildGatewayServer({
      manager,
      accessTokens: {
        authenticate: async (token) => token === "backpressure-token-fixture" ? principal : undefined,
        mintRunToken: async () => { throw new Error("not used"); },
        revoke: () => undefined,
      },
    });
    cleanup.push(() => gateway.close());
    const address = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/v1/runs/run-backpressure/events`, {
      headers: { authorization: "Bearer backpressure-token-fixture" }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await polling;
    controller.abort(new Error("client closed stream"));
    await aborted;
  });

  it("aborts the in-flight Unix-socket or named-pipe request when the Gateway cancels it", async () => {
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\lite-harness-ipc-${randomUUID()}`
      : join(tmpdir(), `lite-harness-ipc-${randomUUID()}.sock`);
    let notifyRequest!: () => void;
    let notifyDisconnected!: () => void;
    const requested = new Promise<void>((resolve) => { notifyRequest = resolve; });
    const disconnected = new Promise<void>((resolve) => { notifyDisconnected = resolve; });
    const server = createServer((request) => {
      notifyRequest();
      request.once("aborted", notifyDisconnected);
      request.socket.once("close", notifyDisconnected);
    });
    server.listen(socketPath);
    await once(server, "listening");
    cleanup.push(async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close").catch(() => undefined);
    });

    const controller = new AbortController();
    const pending = new ManagerClient(socketPath, "internal-token", 60_000)
      .getEvents("run-backpressure", 0, 10_000, controller.signal);
    await requested;
    controller.abort(new Error("SSE downstream disconnected"));
    await expect(pending).rejects.toThrow();
    await disconnected;
  });
});

function event(sequence: number, content: string): RunEvent {
  return {
    runId: "run-backpressure", sequence, type: "agent.message.delta", payload: { content },
    createdAt: new Date(sequence).toISOString(),
  };
}

function runRecord(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-backpressure", idempotencyKey: "key", appId: principal.appId, tenantId: principal.tenantId,
    userId: principal.userId, agentId: "agent", workspaceId: "workspace", depth: 0, deliveryAllowed: true,
    input: "stream", budget: {
      maxTurns: 8, maxToolCalls: 32, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1,
      totalTimeoutMs: 60_000, modelIdleTimeoutMs: 10_000, commandTimeoutMs: 10_000,
    }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 }, status: "RUNNING",
    lastSequence: 1, createdAt: now, updatedAt: now,
  };
}
