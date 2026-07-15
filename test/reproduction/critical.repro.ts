import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, type ModelEvent, type ModelGateway, type ModelMessage } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { createOpenClawCompatibilityWorker, inspectPluginManifest, PluginPackageInstaller, PluginInstallLock } from "@lite-harness/plugin-core";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { buildGatewayServer, type ManagerTransport } from "../../apps/gateway/src/server.js";
import { buildManagerServer } from "../../apps/manager/src/server.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const principal = { appId: "app_local", tenantId: "tenant", userId: "user", scopes: ["runs:create"] };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("critical baseline defect reproductions", () => {
  it("BD-001-REPRO binds public identity to the bearer token instead of caller headers", async () => {
    let acceptedPrincipal: unknown;
    const manager = {
      async startRun(request: { principal: unknown }) {
        acceptedPrincipal = request.principal;
        return { runId: "run_spoofed", status: "ACCEPTED", eventCursor: 0, idempotentReplay: false };
      },
    } as unknown as ManagerTransport;
    const app = buildGatewayServer({
      manager,
      accessTokens: {
        authenticate: async () => principal,
        mintRunToken: async () => { throw new Error("not needed"); },
        revoke: () => undefined,
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: {
          authorization: "Bearer shared-app-token",
          "x-lite-tenant-id": "victim-tenant",
          "x-lite-user-id": "owner-user",
        },
        payload: { agent: "coder", workspace: "workspace", input: "impersonated request" },
      });
      expect({ statusCode: response.statusCode, acceptedPrincipal }).toEqual({
        statusCode: 202,
        acceptedPrincipal: principal,
      });
    } finally {
      await app.close();
    }
  });

  it("BD-002-REPRO renews a workspace lease for the full active run", async () => {
    const store = new SqliteRunStore(temporaryDatabase());
    const model = abortableBlockedModel();
    const service = new RunService(store, new AgentRunner(model.gateway, new InMemoryToolRuntime()), {
      workspaceLeaseTtlMs: 30,
      workspaceQueueTimeoutMs: 500,
    });
    const created = service.createRun({
      agent: "coder", workspace: "lease-workspace", input: "hold", idempotencyKey: "lease", principal,
      budget: { totalTimeoutMs: 2_000 },
    });
    try {
      await waitUntil(() => service.listEvents(created.runId).some((event) => event.type === "workspace.lease.acquired"));
      await delay(60);
      const stolen = store.acquireWorkspaceLease("lease-workspace", "intruder-run", 100);
      expect(stolen).toBeUndefined();
    } finally {
      service.cancelRun(created.runId);
      model.release();
      await delay(20);
      store.close();
    }
  });

  it("BD-003-REPRO enforces a hard deadline even when provider iterator cleanup hangs", async () => {
    const never = new Promise<never>(() => undefined);
    const model: ModelGateway = {
      streamTurn() {
        return {
          [Symbol.asyncIterator]() {
            return { next: () => never, return: () => never };
          },
        };
      },
    };
    const run = new AgentRunner(model, new InMemoryToolRuntime()).run({
      input: "hang", workspaceId: "workspace", modelIdleTimeoutMs: 10, onEvent: () => undefined,
    });
    const outcome = await Promise.race([run.then(() => "settled", () => "settled"), delay(100).then(() => "hung")]);
    expect(outcome).toBe("settled");
  });

  it("BD-004-REPRO prevents events from being appended after a terminal transition", async () => {
    const store = new SqliteRunStore(temporaryDatabase());
    const model = manuallyReleasedModel();
    const service = new RunService(store, new AgentRunner(model.gateway, new InMemoryToolRuntime()));
    const created = service.createRun({ agent: "coder", workspace: "terminal-workspace", input: "hold", idempotencyKey: "terminal", principal });
    try {
      await waitUntil(() => service.getRun(created.runId)?.status === "RUNNING");
      service.cancelRun(created.runId);
      model.release();
      await delay(40);
      expect(service.listEvents(created.runId).at(-1)?.type).toBe("run.cancelled");
    } finally {
      service.cancelRun(created.runId);
      model.release();
      await delay(20);
      store.close();
    }
  });

  it("BD-005-REPRO drains active runs before Manager shutdown closes durable state", async () => {
    const store = new SqliteRunStore(temporaryDatabase());
    const model = manuallyReleasedModel();
    const service = new RunService(store, new AgentRunner(model.gateway, new InMemoryToolRuntime()));
    const app = buildManagerServer({
      runService: service,
      internalToken: "internal",
      productionReadinessChecks: async () => ({ embedded: { ok: true } }),
    });
    const created = service.createRun({ agent: "coder", workspace: "shutdown-workspace", input: "hold", idempotencyKey: "shutdown", principal });
    try {
      await waitUntil(() => service.getRun(created.runId)?.status === "RUNNING");
      await app.close();
      expect(service.getRun(created.runId)?.status).not.toBe("RUNNING");
    } finally {
      service.cancelRun(created.runId);
      model.release();
      await delay(20);
      store.close();
    }
  });

  it("BD-006-REPRO never unlinks a live Unix Manager socket before exclusive ownership", () => {
    const source = readFileSync(join(process.cwd(), "apps", "manager", "src", "main.ts"), "utf8");
    const listen = source.indexOf("await app.listen({ path: socketPath })");
    const unlink = source.indexOf("rmSync(socketPath, { force: true })");
    expect(unlink === -1 || unlink > listen).toBe(true);
  });

  it("BD-007-REPRO rejects plugin versions that escape the installation root", () => {
    const root = temporaryRoot();
    const source = join(root, "source");
    const install = join(root, "install");
    writePlugin(source, "../../escaped-version", "export default { invoke() { return 'ok'; } };\n");
    const installer = new PluginPackageInstaller(install, new PluginInstallLock(join(root, "state", "plugins.json")));
    expect(() => installer.stage(source)).toThrow(/version|escape|install root/i);
  });

  it("BD-008-REPRO enforces denied file grants outside the plugin process", async () => {
    const root = temporaryRoot();
    const pluginRoot = join(root, "plugin");
    writeFileSync(join(root, "host-secret.txt"), "host-only-secret", { encoding: "utf8", flag: "w" });
    writePlugin(pluginRoot, "1.0.0", "import { readFileSync } from 'node:fs'; export default { invoke() { return readFileSync('../host-secret.txt', 'utf8'); } };\n");
    const plugin = inspectPluginManifest(join(pluginRoot, "lite-plugin.json"));
    const none = { tools: [], secrets: [], events: [], files: [], networkOrigins: [] };
    const worker = createOpenClawCompatibilityWorker(plugin, none, {}, { timeoutMs: 1_000 });
    try {
      await expect(worker.invoke("read", {})).rejects.toThrow(/permission|denied|grant/i);
    } finally {
      await worker.stop();
    }
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lite-defect-repro-"));
  roots.push(root);
  return root;
}

function temporaryDatabase(): string {
  return join(temporaryRoot(), "state.db");
}

function writePlugin(root: string, version: string, implementation: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "worker.mjs"), implementation);
  writeFileSync(join(root, "lite-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "example.reproduction",
    version,
    entry: "worker.mjs",
    trust: "openclaw-compat",
    permissions: { tools: [], secrets: [], events: [], files: [], networkOrigins: [] },
  }));
}

function abortableBlockedModel(): { gateway: ModelGateway; release(): void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    gateway: {
      async *streamTurn(params: { messages: readonly ModelMessage[]; signal?: AbortSignal }): AsyncIterable<ModelEvent> {
        await Promise.race([gate, aborted(params.signal)]);
        params.signal?.throwIfAborted();
        yield { type: "completed", finishReason: "stop" };
      },
    },
  };
}

function manuallyReleasedModel(): { gateway: ModelGateway; release(): void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    gateway: {
      async *streamTurn(): AsyncIterable<ModelEvent> {
        await gate;
        yield { type: "text.delta", delta: "late" };
        yield { type: "completed", finishReason: "stop" };
      },
    },
  };
}

function aborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reproduction precondition");
    await delay(5);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
