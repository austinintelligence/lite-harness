import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlObservabilitySink, StructuredObservability } from "@lite-harness/observability";
import { buildGatewayServer, type GatewayServerOptions } from "../apps/gateway/src/server.js";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { buildManagerServer } from "../apps/manager/src/server.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("structured observability", () => {
  it("redacts secrets and omits prompt, file, path, and stack content", () => {
    let now = 1_000;
    const observability = new StructuredObservability({ now: () => now, maxEvents: 20 });
    const span = observability.startTrace("http.request", {
      service: "gateway", method: "POST", route: "/v1/runs", apiKey: "secret-value",
      prompt: "do not persist this", filePath: "C:\\private\\prompt.txt", stack: "private stack",
    });
    now += 17;
    span.end({ statusCode: 202, outcome: "completed" });
    observability.audit("run.accepted", "accepted", { runId: "run_123", authorization: "Bearer secret" }, span);

    const snapshot = observability.snapshot();
    const trace = snapshot.events.find((event) => event.kind === "trace");
    expect(trace).toMatchObject({ kind: "trace", durationMs: 17, attributes: {
      service: "gateway", method: "POST", route: "/v1/runs", apiKey: "[REDACTED]",
      statusCode: 202, outcome: "completed",
    } });
    expect(JSON.stringify(snapshot)).not.toContain("do not persist this");
    expect(JSON.stringify(snapshot)).not.toContain("private stack");
    expect(JSON.stringify(snapshot)).not.toContain("prompt.txt");
    expect(snapshot.counters["trace.http.request.completed"]).toBe(1);
    expect(snapshot.histograms["trace.http.request.duration_ms"]).toMatchObject({ count: 1, sum: 17, max: 17 });
  });

  it("keeps metric values finite and bounds in-memory events", () => {
    const observability = new StructuredObservability({ maxEvents: 2 });
    observability.counter("requests.total", 1, { service: "gateway" });
    observability.observe("requests.duration_ms", 5, { service: "gateway" });
    observability.audit("request", "completed", { service: "gateway" });
    expect(observability.snapshot().events).toHaveLength(2);
    expect(() => observability.counter("bad", Number.NaN)).toThrow(/finite/);
    expect(() => observability.observe("bad", Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("writes redacted JSONL events through a bounded durable sink", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-observability-"));
    roots.push(root);
    const path = join(root, "nested", "events.jsonl");
    const observability = new StructuredObservability({ sinks: [new JsonlObservabilitySink(path)] });
    observability.audit("run.completed", "completed", { service: "manager", token: "secret-value" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ schemaVersion: 1, kind: "audit", attributes: {
      service: "manager", token: "[REDACTED]",
    } });
  });

  it("propagates a trace ID and records request metrics/audit at the Gateway boundary", async () => {
    const observability = new StructuredObservability();
    const gateway = buildGatewayServer({
      manager: {} as GatewayServerOptions["manager"],
      accessTokens: {} as GatewayServerOptions["accessTokens"],
      observability,
    });
    try {
      const response = await gateway.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-lite-trace-id"]).toMatch(/^[a-f0-9]{32}$/);
      const events = observability.snapshot().events;
      expect(events.some((event) => event.kind === "trace" && event.attributes.route === "/healthz")).toBe(true);
      expect(events.some((event) => event.kind === "audit" && event.name === "http.request")).toBe(true);
      expect(events.some((event) => event.kind === "metric" && event.name === "http.requests.total")).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("propagates a trace ID and records request metrics/audit at the Manager boundary", async () => {
    const observability = new StructuredObservability();
    const store = new SqliteRunStore(":memory:");
    const manager = buildManagerServer({
      runService: new RunService(store, new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime())),
      internalToken: "manager-observability-token",
      observability,
      productionReadinessChecks: async () => ({}),
    });
    try {
      const response = await manager.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-lite-trace-id"]).toMatch(/^[a-f0-9]{32}$/);
      expect(observability.snapshot().events.some((event) => event.attributes.service === "manager")).toBe(true);
    } finally {
      await manager.close();
      store.close();
    }
  });

  it("records run lifecycle telemetry without persisting the prompt", async () => {
    const observability = new StructuredObservability();
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(
      store,
      new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()),
      { observability },
    );
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] };
    try {
      const created = service.createRun({
        agent: "coder", workspace: "observability-workspace", input: "private prompt that must not be logged",
        idempotencyKey: "observability-run", principal,
      });
      await expect(service.waitForTerminal(created.runId)).resolves.toMatchObject({ status: "SUCCEEDED" });
      const snapshot = observability.snapshot();
      expect(snapshot.events.some((event) => event.kind === "audit" && event.name === "run.accepted")).toBe(true);
      expect(snapshot.events.some((event) => event.kind === "audit" && event.name === "run.terminal" && event.attributes.status === "SUCCEEDED")).toBe(true);
      expect(snapshot.events.some((event) => event.kind === "trace" && event.name === "run.execute" && event.attributes.runId === created.runId && event.attributes.status === "SUCCEEDED")).toBe(true);
      expect(snapshot.events.some((event) => event.kind === "audit" && event.name === "run.terminal" && event.traceId === snapshot.events.find((candidate) => candidate.kind === "trace" && candidate.name === "run.execute")?.traceId)).toBe(true);
      expect(snapshot.counters["runs.accepted.total"]).toBe(1);
      expect(snapshot.counters["runs.terminal.total"]).toBe(1);
      expect(snapshot.counters["runs.succeeded.total"]).toBe(1);
      expect(snapshot.counters["model.input_tokens.total"]).toBeGreaterThan(0);
      expect(snapshot.counters["model.output_tokens.total"]).toBeGreaterThan(0);
      expect(snapshot.events.some((event) => event.kind === "metric" && event.name === "model.input_tokens.total" && typeof event.attributes.attemptId === "string")).toBe(true);
      expect(snapshot.histograms["run.queue_wait_ms"]?.count).toBe(1);
      expect(snapshot.histograms["model.cost_usd"]?.count).toBeGreaterThan(0);
      expect(snapshot.histograms["run.time_to_first_model_token_ms"]?.count).toBe(1);
      expect(snapshot.histograms["run.time_to_first_visible_event_ms"]?.count).toBe(1);
      expect(JSON.stringify(snapshot)).not.toContain("private prompt that must not be logged");

      const replay = service.createRun({
        agent: "coder", workspace: "observability-workspace", input: "private prompt that must not be logged",
        idempotencyKey: "observability-run", principal,
      });
      expect(replay.runId).toBe(created.runId);
      expect(observability.snapshot().counters["runs.idempotent_replays.total"]).toBe(1);
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  it("keeps run execution successful when the observability port throws", async () => {
    const store = new SqliteRunStore(":memory:");
    const service = new RunService(
      store,
      new AgentRunner(new FakeModelGateway(), new InMemoryToolRuntime()),
      {
        observability: {
          startTrace: () => { throw new Error("trace sink unavailable"); },
          counter: () => { throw new Error("counter sink unavailable"); },
          observe: () => { throw new Error("metric sink unavailable"); },
          audit: () => { throw new Error("audit sink unavailable"); },
        },
      },
    );
    try {
      const created = service.createRun({
        agent: "coder", workspace: "observability-failure-workspace", input: "safe execution",
        idempotencyKey: "observability-failure", principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
      });
      await expect(service.waitForTerminal(created.runId)).resolves.toMatchObject({ status: "SUCCEEDED" });
    } finally {
      await service.shutdown();
      store.close();
    }
  });
});
