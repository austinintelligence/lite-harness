import { createHash, randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_BUDGET,
  LITE_IPC_PROTOCOL_VERSION,
  LITE_IPC_VERSION_HEADER,
} from "@lite-harness/contracts";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");
const packagedManager = requiredPackagedManager();
const roots: string[] = [];
let activeManager: PackagedPluginManager | undefined;

afterEach(async () => {
  await activeManager?.stop().catch(() => undefined);
  activeManager = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged Manager Docker plugin lifecycle over local IPC", () => {
  it("A18-REAL-MANAGER-PLUGIN-LIFECYCLE covers both ABIs through the separate production Manager without leaks", async () => {
    const dataDir = temporaryRoot("state");
    const officialV1 = pluginPackage("example.official-real", "1.0.0", "official", ["official_echo"], officialSource("1.0.0"));
    const officialV2 = pluginPackage("example.official-real", "2.0.0", "official", ["official_echo"], officialSource("2.0.0"));
    const officialFailedV3 = pluginPackage("example.official-real", "3.0.0", "official", ["official_echo"], `
      export default {
        invoke(action, input) { return { action, input, version: "3.0.0" }; },
        migrate() { return { migrated: false, reason: "fixture rejection" }; }
      };
    `);
    const compatV1 = pluginPackage("example.openclaw-real", "1.0.0", "openclaw-compat", ["compat_echo"], compatibilitySource("1.0.0"));
    const compatV2 = pluginPackage("example.openclaw-real", "2.0.0", "openclaw-compat", ["compat_echo"], compatibilitySource("2.0.0"));
    const compatFailedV3 = pluginPackage("example.openclaw-real", "3.0.0", "openclaw-compat", ["compat_echo"], `
      export default {
        register(api) { api.registerTool({ name: "compat_echo", execute(input) { return { version: "3.0.0", input }; } }); },
        migrate() { return { migrated: false, reason: "compat fixture rejection" }; }
      };
    `);

    activeManager = await startPackagedManager(dataDir);
    let manager = activeManager;
    try {
      expect(manager.pid).not.toBe(process.pid);
      expect(manager.socketPath).toMatch(process.platform === "win32" ? /^\\\\\.\\pipe\\/ : /manager\.sock$/);

      const officialInspection = await manager.request("POST", "/internal/plugins/inspect", { path: officialV1 });
      expect(officialInspection.status).toBe(200);
      expect(officialInspection.body).toMatchObject({ manifest: { id: "example.official-real", version: "1.0.0" } });
      expect((await manager.request("POST", "/internal/plugins/inspect", { path: officialV2 })).status).toBe(200);
      expect((await manager.request("POST", "/internal/plugins/install", {
        sourceRoot: officialV1, grant: { tools: ["official_echo"] },
      })).body).toMatchObject({ version: "1.0.0", enabled: false, installState: "verified" });
      expect(managedContainers(dataDir)).toEqual([]);
      expect((await manager.request("POST", "/internal/plugins/example.official-real/1.0.0/enable")).status).toBe(200);
      expect((await manager.status()).plugins.find((plugin) => plugin.active)?.worker.active).toBe(false);
      expect(managedContainers(dataDir)).toEqual([]);

      const officialSuccess = await manager.run("official", { value: 1 });
      expect(officialSuccess.terminal.status).toBe("SUCCEEDED");
      expect(officialSuccess.result).toMatchObject({ version: "1.0.0", input: { value: 1 } });
      expect(officialSuccess.pluginVersion).toBe("1.0.0");
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);

      const officialCrash = await manager.run("official", { mode: "crash" });
      expect(officialCrash.terminal.status).toBe("FAILED");
      expect((await manager.run("official", { value: "backoff" })).terminal.status).toBe("FAILED");
      expect((await manager.request("GET", "/healthz")).status).toBe(200);
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      await delay(3_100);
      expect((await manager.run("official", { value: "restart-after-crash" })).result).toMatchObject({ version: "1.0.0" });

      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      expect((await manager.run("official", { mode: "hang" })).terminal.status).toBe("FAILED");
      expect((await manager.request("GET", "/healthz")).status).toBe(200);
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      await delay(3_100);

      const pinnedOfficialRun = await manager.startRun("official", { mode: "delay", delayMs: 1_000 });
      await waitFor(() => managedContainers(dataDir).length >= 1, 30_000);
      const officialUpgrade = await manager.request("POST", "/internal/plugins/example.official-real/upgrade", {
        sourceRoot: officialV2, grant: { tools: ["official_echo"] },
      });
      expect(officialUpgrade.status, JSON.stringify(officialUpgrade.body)).toBe(200);
      expect(officialUpgrade.body).toMatchObject({
        entry: { version: "2.0.0", enabled: true, installState: "verified" },
        previousVersion: "1.0.0",
        migration: { rollbackPossible: true, stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      const pinnedOfficial = await manager.completedRun(pinnedOfficialRun);
      expect(pinnedOfficial.terminal.status).toBe("SUCCEEDED");
      expect(pinnedOfficial.result).toMatchObject({ version: "1.0.0" });
      expect(pinnedOfficial.pluginVersion).toBe("1.0.0");
      const officialV2Run = await manager.run("official", { value: "after-upgrade" });
      expect(officialV2Run.result).toMatchObject({
        version: "2.0.0", state: { migratedFrom: "1.0.0", migratedTo: "2.0.0" },
      });
      expect(officialV2Run.pluginVersion).toBe("2.0.0");
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);

      const failedOfficialUpgrade = await manager.request("POST", "/internal/plugins/example.official-real/upgrade", {
        sourceRoot: officialFailedV3, grant: { tools: ["official_echo"] },
      });
      expect(failedOfficialUpgrade.status).toBe(409);
      const officialAfterFailure = await manager.status();
      expect(officialAfterFailure).toMatchObject({ active: [{ id: "example.official-real", version: "2.0.0" }] });
      expect(officialAfterFailure.plugins.map((plugin) => plugin.version)).not.toContain("3.0.0");
      expect(managedContainers(dataDir)).toEqual([]);

      await manager.stop();
      activeManager = undefined;
      expect(managedContainers(dataDir)).toEqual([]);
      manager = await startPackagedManager(dataDir);
      activeManager = manager;
      expect(await manager.status()).toMatchObject({ active: [{ id: "example.official-real", version: "2.0.0" }] });
      expect((await manager.run("official", { value: "manager-restart" })).result).toMatchObject({ version: "2.0.0" });
      expect((await manager.request("POST", "/internal/plugins/example.official-real/rollback")).body).toMatchObject({
        version: "1.0.0", enabled: true,
      });
      expect((await manager.run("official", { value: "explicit-rollback" })).result).toMatchObject({ version: "1.0.0" });
      expect((await manager.request("POST", "/internal/plugins/example.official-real/disable")).status).toBe(200);
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      expect((await manager.run("official", { value: "disabled" })).terminal.status).toBe("FAILED");
      expect((await manager.request("DELETE", "/internal/plugins/example.official-real/2.0.0")).body).toEqual({ removed: true });
      expect((await manager.request("DELETE", "/internal/plugins/example.official-real/1.0.0")).body).toEqual({ removed: true });

      for (const fixture of [compatV1, compatV2]) {
        const inspection = await manager.request("POST", "/internal/plugins/inspect", { path: fixture });
        expect(inspection.status).toBe(200);
        expect(inspection.body).toMatchObject({
          manifest: { id: "example.openclaw-real" },
          compatibility: { adapter: "openclaw-worker-v1" },
        });
      }
      expect((await manager.request("POST", "/internal/plugins/install", {
        sourceRoot: compatV1, grant: { tools: ["compat_echo"] },
      })).status).toBe(200);
      expect((await manager.request("POST", "/internal/plugins/example.openclaw-real/1.0.0/enable")).status).toBe(200);
      expect((await manager.run("compat", { value: 7 })).result).toMatchObject({
        adapter: "openclaw-worker-v1", active: true, version: "1.0.0", input: { value: 7 }, state: {},
      });
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      expect((await manager.run("compat", { mode: "crash" })).terminal.status).toBe("FAILED");
      expect((await manager.run("compat", { value: "backoff" })).terminal.status).toBe("FAILED");
      expect((await manager.request("GET", "/healthz")).status).toBe(200);
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      await delay(3_100);
      expect((await manager.run("compat", { value: "restart-after-crash" })).result).toMatchObject({ version: "1.0.0" });
      expect((await manager.run("compat", { mode: "hang" })).terminal.status).toBe("FAILED");
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      await delay(3_100);

      const pinnedCompatRun = await manager.startRun("compat", { mode: "delay", delayMs: 1_000 });
      await waitFor(() => managedContainers(dataDir).length >= 1, 30_000);
      const compatUpgrade = await manager.request("POST", "/internal/plugins/example.openclaw-real/upgrade", {
        sourceRoot: compatV2, grant: { tools: ["compat_echo"] },
      });
      expect(compatUpgrade.status, JSON.stringify(compatUpgrade.body)).toBe(200);
      expect(compatUpgrade.body).toMatchObject({
        entry: { version: "2.0.0", enabled: true }, previousVersion: "1.0.0",
        migration: { rollbackPossible: true, stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      const pinnedCompat = await manager.completedRun(pinnedCompatRun);
      expect(pinnedCompat.result).toMatchObject({ version: "1.0.0" });
      expect(pinnedCompat.pluginVersion).toBe("1.0.0");
      const compatV2Run = await manager.run("compat", { value: "after-upgrade" });
      expect(compatV2Run.result).toMatchObject({
        version: "2.0.0",
        state: { migratedFrom: "1.0.0", migratedTo: "2.0.0", priorState: {} },
      });
      expect(compatV2Run.pluginVersion).toBe("2.0.0");
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);

      const failedCompatUpgrade = await manager.request("POST", "/internal/plugins/example.openclaw-real/upgrade", {
        sourceRoot: compatFailedV3, grant: { tools: ["compat_echo"] },
      });
      expect(failedCompatUpgrade.status).toBe(409);
      expect(await manager.status()).toMatchObject({ active: [{ id: "example.openclaw-real", version: "2.0.0" }] });
      expect(managedContainers(dataDir)).toEqual([]);

      await manager.stop();
      activeManager = undefined;
      manager = await startPackagedManager(dataDir);
      activeManager = manager;
      expect((await manager.run("compat", { value: "manager-restart" })).result).toMatchObject({ version: "2.0.0" });
      expect((await manager.request("POST", "/internal/plugins/example.openclaw-real/disable")).status).toBe(200);
      expect((await manager.request("POST", "/internal/plugins/example.openclaw-real/2.0.0/enable")).status).toBe(200);
      expect((await manager.request("POST", "/internal/plugins/example.openclaw-real/rollback")).body).toMatchObject({
        version: "1.0.0", enabled: true,
      });
      expect((await manager.run("compat", { value: "explicit-rollback" })).result).toMatchObject({ version: "1.0.0" });
      expect((await manager.request("POST", "/internal/plugins/example.openclaw-real/disable")).status).toBe(200);
      expect((await manager.request("DELETE", "/internal/plugins/example.openclaw-real/2.0.0")).body).toEqual({ removed: true });
      expect((await manager.request("DELETE", "/internal/plugins/example.openclaw-real/1.0.0")).body).toEqual({ removed: true });
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
      expect((await manager.request("GET", "/healthz")).status).toBe(200);
      expect(await manager.status()).toMatchObject({ plugins: [], active: [] });
    } finally {
      await manager.stop().catch(() => undefined);
      if (activeManager === manager) activeManager = undefined;
      await waitFor(() => managedContainers(dataDir).length === 0, 30_000);
    }
  }, 300_000);
});

interface RequestResult { status: number; body: unknown }
interface PluginStatus {
  plugins: Array<{ id: string; version: string; active: boolean; worker: { active: boolean } }>;
  active: Array<{ id: string; version: string; digest: string }>;
}
interface RunRecordResult { id: string; status: string }
interface RunEventResult { type: string; payload: Record<string, unknown> }

class PackagedPluginManager {
  readonly #exit: Promise<void>;
  #logs = "";

  constructor(
    readonly dataDir: string,
    readonly socketPath: string,
    readonly child: ChildProcessWithoutNullStreams,
  ) {
    this.#exit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const capture = (chunk: Buffer) => {
      this.#logs = `${this.#logs}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  get pid(): number { return this.child.pid ?? -1; }

  async request(method: string, path: string, body?: unknown): Promise<RequestResult> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return await new Promise<RequestResult>((resolveRequest, rejectRequest) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          [LITE_IPC_VERSION_HEADER]: LITE_IPC_PROTOCOL_VERSION,
          "x-lite-internal-token": internalToken,
          "x-lite-app-id": owner.appId,
          "x-lite-tenant-id": owner.tenantId,
          "x-lite-user-id": owner.userId,
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) {
            request.destroy(new Error("Manager IPC response exceeded 32 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolveRequest({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) as unknown : undefined });
          } catch (error) { rejectRequest(error); }
        });
      });
      request.once("error", rejectRequest);
      if (payload) request.write(payload);
      request.end();
    });
  }

  async initializeFixtures(): Promise<void> {
    for (const profile of [
      { id: "official", name: "Official plugin", tool: "official_echo" },
      { id: "compat", name: "OpenClaw compatibility plugin", tool: "compat_echo" },
    ]) {
      const existing = await this.request("GET", `/internal/agents/${profile.id}`);
      if (existing.status === 404) {
        const created = await this.request("POST", "/internal/agents", {
          id: profile.id,
          name: profile.name,
          instructions: "Invoke the only advertised plugin tool.",
          modelCapabilities: ["text", "tools"],
          allowedTools: [profile.tool],
          defaultBudget: { ...DEFAULT_RUN_BUDGET, totalTimeoutMs: 30_000, commandTimeoutMs: 8_000 },
          principal: { ...owner, scopes: [] },
        });
        if (created.status !== 201) throw new Error(`Could not create plugin agent: ${JSON.stringify(created.body)}`);
      } else if (existing.status !== 200) throw new Error(`Could not inspect plugin agent: ${JSON.stringify(existing.body)}`);
    }
    const workspace = await this.request("GET", "/internal/workspaces/workspace");
    if (workspace.status === 404) {
      const created = await this.request("POST", "/internal/workspaces", {
        id: "workspace", mode: "managed", principal: { ...owner, scopes: [] },
      });
      if (created.status !== 201) throw new Error(`Could not create plugin workspace: ${JSON.stringify(created.body)}`);
    } else if (workspace.status !== 200) throw new Error(`Could not inspect plugin workspace: ${JSON.stringify(workspace.body)}`);
  }

  async status(): Promise<PluginStatus> {
    const response = await this.request("GET", "/internal/plugins");
    if (response.status !== 200) throw new Error(`Could not read plugin status: ${JSON.stringify(response.body)}`);
    return response.body as PluginStatus;
  }

  async startRun(agent: "official" | "compat", input: Record<string, unknown>): Promise<string> {
    const response = await this.request("POST", "/internal/runs", {
      agent,
      workspace: "workspace",
      input: JSON.stringify(input),
      idempotencyKey: `${agent}-${randomUUID()}`,
      principal: { ...owner, scopes: ["runs:create"] },
    });
    if (response.status !== 202) throw new Error(`Could not start plugin run: ${JSON.stringify(response.body)}`);
    return (response.body as { runId: string }).runId;
  }

  async completedRun(runId: string): Promise<{
    runId: string;
    terminal: RunRecordResult;
    result: unknown;
    pluginVersion?: string;
  }> {
    const terminal = await this.waitForTerminal(runId);
    const eventsResponse = await this.request("GET", `/internal/runs/${runId}/events?after=0&wait_ms=0`);
    if (eventsResponse.status !== 200) throw new Error(`Could not read run events: ${JSON.stringify(eventsResponse.body)}`);
    const events = (eventsResponse.body as { events: RunEventResult[] }).events;
    const completion = events.findLast((event) => event.type === "tool.call.completed");
    const content = completion?.payload.content;
    let result: unknown;
    if (typeof content === "string") {
      try { result = JSON.parse(content) as unknown; } catch { result = content; }
    }
    const metadata = completion?.payload.metadata;
    return {
      runId,
      terminal,
      result,
      ...(metadata && typeof metadata === "object" && typeof (metadata as Record<string, unknown>).pluginVersion === "string"
        ? { pluginVersion: (metadata as Record<string, string>).pluginVersion }
        : {}),
    };
  }

  async run(agent: "official" | "compat", input: Record<string, unknown>) {
    return await this.completedRun(await this.startRun(agent, input));
  }

  async waitForTerminal(runId: string): Promise<RunRecordResult> {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const response = await this.request("GET", `/internal/runs/${runId}`);
      if (response.status !== 200) throw new Error(`Could not read plugin run: ${JSON.stringify(response.body)}`);
      const run = response.body as RunRecordResult;
      if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status)) return run;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for packaged Manager run ${runId}`);
      await delay(50);
    }
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    if (await Promise.race([this.#exit.then(() => true), delay(45_000).then(() => false)])) return;
    this.child.kill("SIGKILL");
    if (!(await Promise.race([this.#exit.then(() => true), delay(10_000).then(() => false)]))) {
      throw new Error(`Packaged Manager did not exit:\n${this.#logs}`);
    }
  }

  failureContext(): string { return this.#logs; }
}

const owner = { appId: "plugin-app", tenantId: "plugin-tenant", userId: "plugin-user" };
const internalToken = "real-plugin-manager-token";

async function startPackagedManager(dataDir: string): Promise<PackagedPluginManager> {
  const socketPath = managerSocketPath(dataDir);
  const child = spawn(process.execPath, [packagedManager], {
    cwd: resolve(import.meta.dirname, ".."),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LITE_HARNESS_CONFIG_VERSION: "1",
      LITE_HARNESS_DATA_DIR: dataDir,
      LITE_HARNESS_MANAGER_SOCKET: socketPath,
      LITE_HARNESS_INTERNAL_TOKEN: internalToken,
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_MODE: "development",
      LITE_HARNESS_ENABLE_PLUGINS: "true",
      LITE_HARNESS_PLUGIN_IMAGE: image,
      LITE_HARNESS_PLUGIN_IDLE_MS: "100",
      LITE_HARNESS_PLUGIN_RPC_TIMEOUT_MS: "10000",
      LITE_HARNESS_PLUGIN_INVOCATION_TIMEOUT_MS: "4000",
      LITE_HARNESS_PLUGIN_CLEANUP_RETRY_MS: "100",
      LITE_HARNESS_PLUGIN_CLEANUP_ATTEMPTS: "3",
      LITE_HARNESS_PLUGIN_CLEANUP_TIMEOUT_MS: "30000",
      LITE_HARNESS_PLUGIN_CRASH_BACKOFF_BASE_MS: "3000",
      LITE_HARNESS_PLUGIN_CRASH_BACKOFF_MAX_MS: "3000",
      LITE_HARNESS_SNAPSHOT_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
  });
  const manager = new PackagedPluginManager(dataDir, socketPath, child);
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Packaged Manager exited during startup:\n${manager.failureContext()}`);
      }
      try {
        const health = await manager.request("GET", "/healthz");
        if (health.status === 200) break;
      } catch { /* local endpoint is not ready yet */ }
      if (Date.now() >= deadline) throw new Error(`Packaged Manager did not become healthy:\n${manager.failureContext()}`);
      await delay(50);
    }
    await manager.initializeFixtures();
    return manager;
  } catch (error) {
    await manager.stop().catch(() => undefined);
    throw error;
  }
}

function officialSource(version: string): string {
  return `
    let state = {};
    export default {
      initialize({ config }) { state = config.state ?? {}; },
      async invoke(action, input) {
        if (input?.mode === "crash") process.exit(23);
        if (input?.mode === "hang") return await new Promise(() => {});
        if (input?.mode === "delay") await new Promise((resolve) => setTimeout(resolve, input.delayMs ?? 1000));
        return { action, input, version: "${version}", state };
      },
      migrate(from, to) {
        return { migrated: true, state: { migratedFrom: from, migratedTo: to }, rollbackPossible: true };
      }
    };
  `;
}

function compatibilitySource(version: string): string {
  return `
    export default {
      register(api, context) {
        let active = false;
        const state = context.state;
        api.registerService({
          start() { active = true; },
          health() { if (!active) throw new Error("compat service inactive"); },
          stop() { active = false; }
        });
        api.registerTool({
          name: "compat_echo",
          async execute(input) {
            if (input?.mode === "crash") process.exit(29);
            if (input?.mode === "hang") return await new Promise(() => {});
            if (input?.mode === "delay") await new Promise((resolve) => setTimeout(resolve, input.delayMs ?? 1000));
            return { adapter: "openclaw-worker-v1", active, version: "${version}", input, state };
          }
        });
      },
      migrate(from, to, context) {
        return {
          migrated: true,
          state: { migratedFrom: from, migratedTo: to, priorState: context.state },
          rollbackPossible: true
        };
      }
    };
  `;
}

function pluginPackage(id: string, version: string, trust: string, tools: string[], source: string): string {
  const root = temporaryRoot(`${id}-${version}`);
  writeFileSync(join(root, "worker.mjs"), `${source}\n`);
  writeFileSync(join(root, "lite-plugin.json"), JSON.stringify({
    schemaVersion: 1, id, version, entry: "worker.mjs", trust,
    permissions: { tools, secrets: [], events: [], files: [], networkOrigins: [] },
  }));
  return root;
}

function managedContainers(installationId: string): string[] {
  const result = spawnSync("docker", [
    "ps", "--all",
    "--filter", "label=lite-harness.managed=true",
    "--filter", "label=lite-harness.component=plugin",
    "--filter", `label=lite-harness.installation=${labelDigest(installationId)}`,
    "--format", "{{.Names}}",
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker container inventory failed: ${result.stderr || result.stdout}`);
  return (result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function labelDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function managerSocketPath(dataDir: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\lite-a18-${labelDigest(dataDir)}`
    : join(dataDir, "manager.sock");
}

function temporaryRoot(suffix: string): string {
  const root = mkdtempSync(join(tmpdir(), `lite-real-plugin-manager-${suffix}-`));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for real plugin lifecycle state");
    await delay(50);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}

function requiredPackagedManager(): string {
  const path = process.env.LITE_HARNESS_PACKAGED_MANAGER?.trim();
  if (!path) throw new Error("LITE_HARNESS_PACKAGED_MANAGER is required; run pnpm build before this real-runtime test");
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`Packaged Manager is missing: ${absolute}`);
  return absolute;
}
