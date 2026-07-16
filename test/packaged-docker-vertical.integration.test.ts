import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dockerWorkspaceVolumeName } from "@lite-harness/runtime-docker";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");
const packagedManager = requiredArtifact("LITE_HARNESS_PACKAGED_MANAGER");
const packagedGateway = requiredArtifact("LITE_HARNESS_PACKAGED_GATEWAY");
const packagedSdk = requiredArtifact("LITE_HARNESS_PACKAGED_SDK");
const activeProcesses = new Set<PackagedProcess>();
const activeProviders = new Set<FixtureProvider>();

afterEach(async () => {
  const failures: unknown[] = [];
  for (const process of [...activeProcesses]) {
    try { await process.stop(); } catch (error) { failures.push(error); }
    if (process.closed) activeProcesses.delete(process);
  }
  for (const provider of [...activeProviders]) {
    try { await provider.stop(); } catch (error) { failures.push(error); }
    if (!provider.server.listening) activeProviders.delete(provider);
  }
  if (failures.length) throw new AggregateError(failures, "A04 fallback cleanup failed");
});

describe("packaged model-to-Docker vertical slice", () => {
  it("A04-PACKAGED-MODEL-DOCKER-ARTIFACT BD-054-REGRESSION runs the packed SDK through real processes, IPC, Docker, artifact publication, and SSE", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const fixtureRoot = mkdtempSync(join(tmpdir(), "lite-a04-vertical-"));
    const dataDir = join(fixtureRoot, "data");
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\lite-a04-${suffix}`
      : join(fixtureRoot, "manager.sock");
    const owner = { appId: "a04-app", tenantId: "a04-tenant", userId: `a04-user-${suffix}` };
    const workspaceId = `a04-workspace-${suffix}`;
    const agentId = `a04-agent-${suffix}`;
    const expectedArtifact = `A04 real Docker artifact ${suffix}\n`;
    const volume = dockerWorkspaceVolumeName(workspaceId, { ...owner, scopes: [] });
    const internalToken = `a04-internal-${suffix}`;
    const appToken = `a04-app-token-${suffix}`;
    const providerToken = `a04-provider-token-${suffix}`;
    let provider: FixtureProvider | undefined;
    let manager: PackagedProcess | undefined;
    let gateway: PackagedProcess | undefined;
    let testFailure: unknown;

    try {
      expect(namedVolumeExists(volume)).toBe(false);
      provider = await FixtureProvider.start(providerToken, expectedArtifact);
      activeProviders.add(provider);
      const environment = {
        ...process.env,
        LITE_HARNESS_CONFIG_VERSION: "1",
        LITE_HARNESS_DATA_DIR: dataDir,
        LITE_HARNESS_MANAGER_SOCKET: socketPath,
        LITE_HARNESS_INTERNAL_TOKEN: internalToken,
        LITE_HARNESS_APP_TOKEN: appToken,
        LITE_HARNESS_APP_ID: owner.appId,
        LITE_HARNESS_TENANT_ID: owner.tenantId,
        LITE_HARNESS_USER_ID: owner.userId,
        LITE_HARNESS_HOST: "127.0.0.1",
        LITE_HARNESS_PROVIDER: "openai-compatible",
        LITE_HARNESS_PROVIDER_BASE_URL: provider.baseUrl,
        LITE_HARNESS_PROVIDER_API_KEY: providerToken,
        LITE_HARNESS_MODEL: "a04-fixture-model",
        LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION: "0",
        LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION: "0",
        LITE_HARNESS_RUNTIME: "docker",
        LITE_HARNESS_RUNTIME_IMAGE: image,
        LITE_HARNESS_MODE: "production",
        LITE_HARNESS_OFFLINE: "true",
        LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT: "false",
        LITE_HARNESS_SHUTDOWN_TIMEOUT_MS: "15000",
        LITE_HARNESS_SNAPSHOT_KEY: Buffer.alloc(32, 4).toString("base64"),
      };

      manager = PackagedProcess.start("Manager", packagedManager, environment, fixtureRoot);
      activeProcesses.add(manager);
      const startedGateway = await startPackagedGateway(environment, fixtureRoot, manager);
      gateway = startedGateway.gateway;
      const baseUrl = startedGateway.baseUrl;
      expect(manager.pid).not.toBe(process.pid);
      expect(gateway.pid).not.toBe(process.pid);
      expect(manager.pid).not.toBe(gateway.pid);

      const sdkRoot = join(fixtureRoot, "packed-sdk");
      mkdirSync(sdkRoot, { recursive: true });
      extractTarball(packagedSdk, sdkRoot);
      const sdkEntry = join(sdkRoot, "package", "dist", "index.js");
      if (!existsSync(sdkEntry)) throw new Error("The packed SDK did not contain dist/index.js");
      const clientScript = join(fixtureRoot, "clean-client.mjs");
      writeFileSync(clientScript, cleanClientSource(pathToFileURL(sdkEntry).href), "utf8");
      const client = await runCleanClient(clientScript, fixtureRoot, {
        A04_BASE_URL: baseUrl,
        A04_APP_TOKEN: appToken,
        A04_AGENT_ID: agentId,
        A04_WORKSPACE_ID: workspaceId,
      });

      expect(client.status).toBe("SUCCEEDED");
      expect(Buffer.from(client.artifactBase64, "base64").toString("utf8")).toBe(expectedArtifact);
      expect(client.requestedTools).toEqual(["write_file", "artifact_publish"]);
      expect(client.completedTools).toEqual([true, true]);
      expect(client.eventTypes.at(-1)).toBe("run.succeeded");
      expect(client.artifactId).toMatch(/^art_[a-f0-9]{32}$/);
      expect(provider.failure).toBeUndefined();
      expect(provider.requests).toHaveLength(3);
      expect(provider.requests[1]?.messages.findLast((message) => message.role === "tool")).toMatchObject({
        tool_call_id: "a04-write", content: "ok",
      });
      expect(provider.requests[2]?.messages.findLast((message) => message.role === "tool")?.content).toMatch(/^Published artifact art_/);
      expect(namedVolumeExists(volume)).toBe(true);
      expect(readNamedVolumeFile(volume, "output/a04-result.txt")).toBe(expectedArtifact);
      await waitForNoManagedContainers(dataDir);
    } catch (error) {
      testFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    for (const process of [gateway, manager]) {
      if (!process) continue;
      try {
        await process.stop();
        activeProcesses.delete(process);
      } catch (error) { cleanupFailures.push(error); }
    }
    if (provider) {
      try {
        await provider.stop();
        activeProviders.delete(provider);
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await waitForNoManagedContainers(dataDir); } catch (error) { cleanupFailures.push(error); }
    try { removeNamedVolumeIfPresent(volume); } catch (error) { cleanupFailures.push(error); }
    if ([gateway, manager].every((process) => !process || process.stopped)) {
      try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
    } else {
      cleanupFailures.push(new Error(`A04 cleanup preserved Manager data at ${fixtureRoot} because a packaged process did not stop`));
    }
    if (testFailure && cleanupFailures.length) {
      throw new AggregateError([testFailure, ...cleanupFailures], "A04 qualification and cleanup both failed");
    }
    if (testFailure) throw testFailure;
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "A04 cleanup failed");
    expect(namedVolumeExists(volume)).toBe(false);
  }, 180_000);

  it("A05-PACKAGED-CONTAINER-SECRET-SENTINELS keeps app, provider, integration, root, and IPC sentinels out of a live Docker tool container", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const fixtureRoot = mkdtempSync(join(tmpdir(), "lite-a05-secrets-"));
    const dataDir = join(fixtureRoot, "data");
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\lite-a05-${suffix}`
      : join(fixtureRoot, "manager.sock");
    const owner = { appId: "a05-app", tenantId: "a05-tenant", userId: `a05-user-${suffix}` };
    const workspaceId = `a05-workspace-${suffix}`;
    const agentId = `a05-agent-${suffix}`;
    const expectedArtifact = `A05 safe artifact ${suffix}\n`;
    const volume = dockerWorkspaceVolumeName(workspaceId, { ...owner, scopes: [] });
    const internalToken = `a05-ipc-${suffix}`;
    const appToken = `a05-app-${suffix}`;
    const providerToken = `a05-provider-${suffix}`;
    const integrationSecret = `a05-integration-${suffix}`;
    const snapshotKey = Buffer.from(`a05-root-${suffix}`.slice(0, 32).padEnd(32, "x"), "utf8").toString("base64");
    const sentinels = [internalToken, appToken, providerToken, integrationSecret, snapshotKey];
    let provider: FixtureProvider | undefined;
    let manager: PackagedProcess | undefined;
    let gateway: PackagedProcess | undefined;
    let testFailure: unknown;

    try {
      expect(namedVolumeExists(volume)).toBe(false);
      provider = await FixtureProvider.start(providerToken, expectedArtifact, { modelId: "a05-fixture-model", mode: "a05" });
      activeProviders.add(provider);
      const environment = {
        ...process.env,
        LITE_HARNESS_CONFIG_VERSION: "1",
        LITE_HARNESS_DATA_DIR: dataDir,
        LITE_HARNESS_MANAGER_SOCKET: socketPath,
        LITE_HARNESS_INTERNAL_TOKEN: internalToken,
        LITE_HARNESS_APP_TOKEN: appToken,
        LITE_HARNESS_APP_ID: owner.appId,
        LITE_HARNESS_TENANT_ID: owner.tenantId,
        LITE_HARNESS_USER_ID: owner.userId,
        LITE_HARNESS_HOST: "127.0.0.1",
        LITE_HARNESS_PROVIDER: "openai-compatible",
        LITE_HARNESS_PROVIDER_BASE_URL: provider.baseUrl,
        LITE_HARNESS_PROVIDER_API_KEY: providerToken,
        LITE_HARNESS_MODEL: "a05-fixture-model",
        LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION: "0",
        LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION: "0",
        LITE_HARNESS_RUNTIME: "docker",
        LITE_HARNESS_RUNTIME_IMAGE: image,
        LITE_HARNESS_MODE: "production",
        LITE_HARNESS_OFFLINE: "true",
        LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT: "false",
        LITE_HARNESS_SHUTDOWN_TIMEOUT_MS: "15000",
        LITE_HARNESS_WEBHOOK_SECRET: integrationSecret,
        LITE_HARNESS_WEBHOOK_ACCOUNT: "a05-account",
        LITE_HARNESS_SNAPSHOT_KEY: snapshotKey,
      };

      manager = PackagedProcess.start("Manager", packagedManager, environment, fixtureRoot);
      activeProcesses.add(manager);
      const startedGateway = await startPackagedGateway(environment, fixtureRoot, manager);
      gateway = startedGateway.gateway;
      const sdkRoot = join(fixtureRoot, "packed-sdk");
      mkdirSync(sdkRoot, { recursive: true });
      extractTarball(packagedSdk, sdkRoot);
      const sdkEntry = join(sdkRoot, "package", "dist", "index.js");
      if (!existsSync(sdkEntry)) throw new Error("The packed SDK did not contain dist/index.js");
      const clientScript = join(fixtureRoot, "secret-client.mjs");
      writeFileSync(clientScript, secretQualificationClientSource(pathToFileURL(sdkEntry).href), "utf8");

      const clientPromise = runCleanClient(clientScript, fixtureRoot, {
        A05_BASE_URL: startedGateway.baseUrl,
        A05_APP_TOKEN: appToken,
        A05_AGENT_ID: agentId,
        A05_WORKSPACE_ID: workspaceId,
      });
      const observed = await observeContainerSecrets(dataDir, sentinels, clientPromise);
      const client = await clientPromise;
      expect(observed.length).toBeGreaterThan(0);
      for (const snapshot of observed) {
        assertNoSentinels(snapshot.inspect, sentinels);
        assertNoSentinels(snapshot.mounts, sentinels);
        assertNoSentinels(snapshot.logs, sentinels);
      }
      expect(client.status).toBe("SUCCEEDED");
      expect(Buffer.from(client.artifactBase64, "base64").toString("utf8")).toBe(expectedArtifact);
      expect(provider.failure).toBeUndefined();
      expect(provider.requests).toHaveLength(4);
      assertNoSentinels(manager.logs, sentinels);
      assertNoSentinels(gateway.logs, sentinels);
      assertNoSentinels(JSON.stringify(client), sentinels);
      assertNoSentinels(JSON.stringify(provider.requests), sentinels);
      expect(namedVolumeExists(volume)).toBe(true);
      expect(readNamedVolumeFile(volume, "output/a05-safe.txt")).toBe(expectedArtifact);
      await waitForNoManagedContainers(dataDir);
    } catch (error) {
      testFailure = provider?.failure ? new AggregateError([error, provider.failure], "A05 fixture provider rejected the qualification") : error;
    }

    const cleanupFailures: unknown[] = [];
    for (const process of [gateway, manager]) {
      if (!process) continue;
      try {
        await process.stop();
        activeProcesses.delete(process);
      } catch (error) { cleanupFailures.push(error); }
    }
    if (provider) {
      try {
        await provider.stop();
        activeProviders.delete(provider);
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await waitForNoManagedContainers(dataDir); } catch (error) { cleanupFailures.push(error); }
    try { removeNamedVolumeIfPresent(volume); } catch (error) { cleanupFailures.push(error); }
    if ([gateway, manager].every((process) => !process || process.stopped)) {
      try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
    } else {
      cleanupFailures.push(new Error(`A05 cleanup preserved Manager data at ${fixtureRoot} because a packaged process did not stop`));
    }
    if (testFailure && cleanupFailures.length) {
      throw new AggregateError([testFailure, ...cleanupFailures], "A05 qualification and cleanup both failed");
    }
    if (testFailure) throw testFailure;
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "A05 cleanup failed");
    expect(namedVolumeExists(volume)).toBe(false);
  }, 180_000);
});

interface ProviderMessage {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: Array<{ function: { name: string } }>;
}

class FixtureProvider {
  readonly requests: ProviderRequest[] = [];
  failure: Error | undefined;

  private constructor(
    readonly server: HttpServer,
    readonly baseUrl: string,
    private readonly token: string,
    private readonly artifactContent: string,
    private readonly modelId = "a04-fixture-model",
    private readonly mode: "a04" | "a05" = "a04",
  ) {}

  static async start(
    token: string,
    artifactContent: string,
    options: { modelId?: string; mode?: "a04" | "a05" } = {},
  ): Promise<FixtureProvider> {
    let provider: FixtureProvider;
    const server = createHttpServer((request, response) => void provider.handle(request, response));
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture provider did not bind a TCP port");
    provider = new FixtureProvider(
      server, `http://127.0.0.1:${address.port}/v1/`, token, artifactContent,
      options.modelId ?? "a04-fixture-model", options.mode ?? "a04",
    );
    return provider;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error("Fixture provider received an unexpected route");
      }
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        throw new Error("Fixture provider authorization was invalid");
      }
      const body = await readProviderRequest(request);
      if (body.model !== this.modelId) throw new Error("Fixture provider received an unexpected model");
      const toolNames = body.tools?.map((tool) => tool.function.name) ?? [];
      if (!toolNames.includes("write_file") || !toolNames.includes("artifact_publish")) {
        throw new Error("Fixture provider did not receive the required advertised tools");
      }
      this.requests.push(body);
      const turn = this.requests.length;
      if (this.mode === "a05") {
        this.handleA05(body, response, turn);
        return;
      }
      if (turn === 1) {
        if (body.messages.some((message) => message.role === "tool")) {
          throw new Error("First provider turn unexpectedly contained a tool result");
        }
        sendSse(response, toolCallChunk("a04-write", "write_file", {
          path: "output/a04-result.txt", content: this.artifactContent,
        }));
        return;
      }
      if (turn === 2) {
        assertToolPair(body.messages, "a04-write", "write_file", "ok");
        sendSse(response, toolCallChunk("a04-publish", "artifact_publish", {
          path: "output/a04-result.txt", mediaType: "text/plain",
        }));
        return;
      }
      if (turn === 3) {
        assertToolPair(body.messages, "a04-publish", "artifact_publish", /^Published artifact art_/);
        sendSse(response, {
          choices: [{ delta: { content: "Published the real Docker artifact." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 24, completion_tokens: 7 },
        });
        return;
      }
      throw new Error("Fixture provider received more than three model turns");
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture provider rejected the request" } }));
    }
  }

  private handleA05(body: ProviderRequest, response: ServerResponse, turn: number): void {
    if (turn === 1) {
      if (body.messages.some((message) => message.role === "tool")) throw new Error("A05 first provider turn unexpectedly contained a tool result");
      sendSse(response, toolCallChunk("a05-sleep", "shell_exec", {
        script: "sleep 4; printf 'a05-safe-output\\n'",
      }));
      return;
    }
    if (turn === 2) {
      assertToolPair(body.messages, "a05-sleep", "shell_exec", /^a05-safe-output/);
      sendSse(response, toolCallChunk("a05-write", "write_file", {
        path: "output/a05-safe.txt", content: this.artifactContent,
      }));
      return;
    }
    if (turn === 3) {
      assertToolPair(body.messages, "a05-write", "write_file", "ok");
      sendSse(response, toolCallChunk("a05-publish", "artifact_publish", {
        path: "output/a05-safe.txt", mediaType: "text/plain",
      }));
      return;
    }
    if (turn === 4) {
      assertToolPair(body.messages, "a05-publish", "artifact_publish", /^Published artifact art_/);
      sendSse(response, {
        choices: [{ delta: { content: "Published the safe A05 artifact." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 24, completion_tokens: 7 },
      });
      return;
    }
    throw new Error("A05 fixture provider received more than four model turns");
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => this.server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
}

class PackagedProcess {
  readonly #close: Promise<void>;
  #logs = "";
  #closed = false;

  private constructor(readonly name: string, readonly child: ChildProcessWithoutNullStreams) {
    this.#close = new Promise<void>((resolveClose) => child.once("close", () => {
      this.#closed = true;
      resolveClose();
    }));
    const capture = (chunk: Buffer) => {
      this.#logs = `${this.#logs}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  static start(name: string, entry: string, environment: NodeJS.ProcessEnv, cwd: string): PackagedProcess {
    return new PackagedProcess(name, spawn(process.execPath, [entry], {
      cwd, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    }));
  }

  get pid(): number { return this.child.pid ?? -1; }
  get stopped(): boolean { return this.child.exitCode !== null || this.child.signalCode !== null; }
  get closed(): boolean { return this.#closed; }
  get logs(): string { return this.#logs; }

  async stop(): Promise<void> {
    if (this.closed) return;
    if (!this.stopped) this.child.kill("SIGTERM");
    if (await settlesBefore(this.#close, 15_000)) return;
    this.child.kill("SIGKILL");
    if (!(await settlesBefore(this.#close, 10_000))) {
      throw new Error(`${this.name} did not exit after SIGKILL:\n${this.logs}`);
    }
  }
}

interface CleanClientResult {
  status: string;
  artifactId: string;
  artifactBase64: string;
  requestedTools: string[];
  completedTools: boolean[];
  eventTypes: string[];
}

async function runCleanClient(
  script: string,
  cwd: string,
  environment: Record<string, string>,
): Promise<CleanClientResult> {
  const child = spawn(process.execPath, [script], {
    cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  const append = (target: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) child.kill("SIGKILL");
    else target.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
  const exit = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  timer.unref?.();
  const code = await exit.finally(() => clearTimeout(timer));
  const output = Buffer.concat(stdout).toString("utf8").trim();
  const error = Buffer.concat(stderr).toString("utf8").trim();
  if (bytes > 1024 * 1024) throw new Error("Clean packed-SDK client output exceeded 1 MiB");
  if (code !== 0) throw new Error(`Clean packed-SDK client failed: ${error || output || `exit ${code}`}`);
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; } catch { throw new Error("Clean packed-SDK client returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object") throw new Error("Clean packed-SDK client result was invalid");
  return parsed as CleanClientResult;
}

function cleanClientSource(sdkUrl: string): string {
  return `import { LiteHarnessClient } from ${JSON.stringify(sdkUrl)};
const client = new LiteHarnessClient({ baseUrl: process.env.A04_BASE_URL, token: process.env.A04_APP_TOKEN });
await client.createAgent({
  id: process.env.A04_AGENT_ID,
  name: "A04 packaged Docker agent",
  instructions: "Write the requested file, publish it, and stop.",
  modelCapabilities: ["text", "tools"],
  allowedTools: ["write_file", "artifact_publish"],
  defaultBudget: { maxTurns: 4, maxToolCalls: 4, totalTimeoutMs: 120000, modelIdleTimeoutMs: 10000, commandTimeoutMs: 30000 },
});
await client.createWorkspace({ id: process.env.A04_WORKSPACE_ID });
const created = await client.createRun({
  agent: process.env.A04_AGENT_ID,
  workspace: process.env.A04_WORKSPACE_ID,
  input: "Create and publish the A04 fixture through real Docker.",
}, "a04-packed-sdk-vertical");
let run;
for (let attempt = 0; attempt < 900; attempt += 1) {
  run = await client.getRun(created.runId);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (run?.status !== "SUCCEEDED") throw new Error("A04 run did not succeed: " + JSON.stringify(run));
const events = [];
for await (const event of client.events(created.runId)) events.push(event);
const artifactId = events.find((event) => event.type === "artifact.created")?.payload?.artifactId;
if (typeof artifactId !== "string") throw new Error("A04 run did not emit artifact.created");
const artifact = await client.downloadArtifact(artifactId);
const requestedTools = events.filter((event) => event.type === "tool.call.requested").map((event) => event.payload.name);
const completedTools = events.filter((event) => event.type === "tool.call.completed").map((event) => event.payload.ok);
process.stdout.write(JSON.stringify({
  status: run.status,
  artifactId,
  artifactBase64: Buffer.from(artifact.data).toString("base64"),
  requestedTools,
  completedTools,
  eventTypes: events.map((event) => event.type),
}));
`;
}

function secretQualificationClientSource(sdkUrl: string): string {
  return `import { LiteHarnessClient } from ${JSON.stringify(sdkUrl)};
const client = new LiteHarnessClient({ baseUrl: process.env.A05_BASE_URL, token: process.env.A05_APP_TOKEN });
await client.createAgent({
  id: process.env.A05_AGENT_ID,
  name: "A05 container secret qualification agent",
  instructions: "Run the qualification tools, write the safe artifact, and stop.",
  modelCapabilities: ["text", "tools"],
  allowedTools: ["shell_exec", "write_file", "artifact_publish"],
  defaultBudget: { maxTurns: 5, maxToolCalls: 5, totalTimeoutMs: 120000, modelIdleTimeoutMs: 10000, commandTimeoutMs: 30000 },
});
await client.createWorkspace({ id: process.env.A05_WORKSPACE_ID });
const created = await client.createRun({
  agent: process.env.A05_AGENT_ID,
  workspace: process.env.A05_WORKSPACE_ID,
  input: "Run the A05 container secret qualification.",
}, "a05-packed-secret-qualification");
let run;
for (let attempt = 0; attempt < 1200; attempt += 1) {
  run = await client.getRun(created.runId);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (run?.status !== "SUCCEEDED") throw new Error("A05 run did not succeed: " + JSON.stringify(run));
const events = [];
for await (const event of client.events(created.runId)) events.push(event);
const artifactId = events.find((event) => event.type === "artifact.created")?.payload?.artifactId;
if (typeof artifactId !== "string") throw new Error("A05 run did not emit artifact.created");
const artifact = await client.downloadArtifact(artifactId);
process.stdout.write(JSON.stringify({
  status: run.status,
  artifactId,
  artifactBase64: Buffer.from(artifact.data).toString("base64"),
  requestedTools: events.filter((event) => event.type === "tool.call.requested").map((event) => event.payload.name),
  completedTools: events.filter((event) => event.type === "tool.call.completed").map((event) => event.payload.ok),
  eventTypes: events.map((event) => event.type),
}));
`;
}

interface ContainerSecretObservation {
  id: string;
  inspect: string;
  mounts: string;
  logs: string;
}

async function observeContainerSecrets(
  dataDir: string,
  sentinels: readonly string[],
  clientPromise: Promise<CleanClientResult>,
): Promise<ContainerSecretObservation[]> {
  const observations: ContainerSecretObservation[] = [];
  const seen = new Set<string>();
  let clientSettled = false;
  void clientPromise.then(() => { clientSettled = true; }, () => { clientSettled = true; });
  const deadline = Date.now() + 90_000;
  while (!clientSettled && Date.now() < deadline) {
    for (const id of managedContainerIds(dataDir)) {
      if (seen.has(id)) continue;
      let inspect: string;
      let mounts: string;
      let logs: string;
      try {
        inspect = dockerText(["inspect", id]);
        const parsed = JSON.parse(inspect) as Array<{ Mounts?: unknown[] }>;
        mounts = JSON.stringify(parsed[0]?.Mounts ?? []);
        logs = dockerText(["logs", id]);
      } catch {
        // A tool can be reaped between inventory and inspect; the next poll can observe its successor.
        continue;
      }
      assertNoSentinels(inspect, sentinels);
      assertNoSentinels(mounts, sentinels);
      assertNoSentinels(logs, sentinels);
      observations.push({ id, inspect, mounts, logs });
      seen.add(id);
    }
    await delay(100);
  }
  if (!clientSettled) throw new Error("A05 client did not finish while observing managed containers");
  return observations;
}

function assertNoSentinels(value: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) expect(value).not.toContain(sentinel);
}

async function readProviderRequest(request: IncomingMessage): Promise<ProviderRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Fixture provider request exceeded 1 MiB");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch {
    throw new Error("Fixture provider request was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as ProviderRequest).messages)) {
    throw new Error("Fixture provider request shape was invalid");
  }
  return parsed as ProviderRequest;
}

function assertToolPair(
  messages: ProviderMessage[],
  callId: string,
  name: string,
  expectedResult: string | RegExp,
): void {
  const assistant = messages.findLast((message) => message.role === "assistant" &&
    message.tool_calls?.some((call) => call.id === callId && call.function.name === name));
  if (!assistant) throw new Error(`Fixture provider did not receive the ${name} assistant tool call`);
  const tool = messages.findLast((message) => message.role === "tool" && message.tool_call_id === callId);
  if (!tool || typeof tool.content !== "string") throw new Error(`Fixture provider did not receive the ${name} tool result`);
  if (typeof expectedResult === "string") assert.equal(tool.content, expectedResult, `${name} result was unexpected`);
  else assert.match(tool.content, expectedResult, `${name} result was unexpected`);
}

function toolCallChunk(id: string, name: string, argumentsValue: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(argumentsValue) } }] },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 18, completion_tokens: 8 },
  };
}

function sendSse(response: ServerResponse, chunk: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "close" });
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

async function startPackagedGateway(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  manager: PackagedProcess,
): Promise<{ gateway: PackagedProcess; baseUrl: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const gateway = PackagedProcess.start("Gateway", packagedGateway, {
      ...environment, LITE_HARNESS_PORT: String(port),
    }, cwd);
    activeProcesses.add(gateway);
    try {
      await waitForGatewayReady(baseUrl, [manager, gateway]);
      return { gateway, baseUrl };
    } catch (error) {
      try {
        await gateway.stop();
      } catch (stopError) {
        throw new AggregateError([error, stopError], "Packaged Gateway startup and cleanup both failed");
      }
      if (!gateway.closed) throw new Error("Packaged Gateway cleanup returned before process streams closed");
      activeProcesses.delete(gateway);
      if (manager.stopped || !/EADDRINUSE|address already in use/i.test(gateway.logs) || attempt === 2) throw error;
    }
  }
  throw new Error("Packaged Gateway exhausted its address-bind attempts");
}

async function waitForGatewayReady(baseUrl: string, processes: PackagedProcess[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastFailure = "not ready";
  for (;;) {
    const exited = processes.find((process) => process.stopped);
    if (exited) throw new Error(`${exited.name} exited before readiness:\n${exited.logs}`);
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json() as { ok?: boolean };
      if (response.ok && body.ok === true) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) { lastFailure = error instanceof Error ? error.message : String(error); }
    if (Date.now() >= deadline) {
      throw new Error(`Packaged Gateway did not become ready (${lastFailure}):\n${processes.map((process) => process.logs).join("\n")}`);
    }
    await delay(100);
  }
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a Gateway port");
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

function extractTarball(tarball: string, destination: string): void {
  const extracted = spawnSync("tar", ["-xzf", tarball, "-C", destination], {
    encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (extracted.error) throw extracted.error;
  if (extracted.status !== 0) throw new Error(`Could not extract the packed SDK: ${extracted.stderr || extracted.stdout}`);
}

function managedContainers(dataDir: string): string[] {
  return dockerText([
    "ps", "--all", "--filter", "label=lite-harness.managed=true",
    "--filter", `label=lite-harness.installation=${labelDigest(dataDir)}`, "--format", "{{.Names}}",
  ]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function managedContainerIds(dataDir: string): string[] {
  return dockerText([
    "ps", "--all", "--filter", "label=lite-harness.managed=true",
    "--filter", `label=lite-harness.installation=${labelDigest(dataDir)}`, "--format", "{{.ID}}",
  ]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

async function waitForNoManagedContainers(dataDir: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (managedContainers(dataDir).length === 0) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for A04 managed-container cleanup");
    await delay(100);
  }
}

function namedVolumeExists(volume: string): boolean {
  const result = spawnSync("docker", ["volume", "inspect", volume], {
    encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (/no such volume/i.test(result.stderr ?? "")) return false;
  throw new Error(`Could not inspect A04 workspace volume: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}

function readNamedVolumeFile(volume: string, path: string): string {
  return dockerText([
    "run", "--pull=never", "--rm", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
    "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32",
    "--mount", `type=volume,src=${volume},dst=/workspace,readonly`,
    image, "sh", "-c", 'set -eu; cat -- "/workspace/$1"', "lite-a04-read", path,
  ]);
}

function removeNamedVolumeIfPresent(volume: string): void {
  if (!namedVolumeExists(volume)) return;
  dockerText(["volume", "rm", volume]);
  if (namedVolumeExists(volume)) throw new Error(`A04 workspace volume remained after removal: ${volume}`);
}

function dockerText(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker command failed: ${result.stderr || result.stdout || args.join(" ")}`);
  return result.stdout ?? "";
}

function labelDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function settlesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}

function requiredArtifact(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  const path = resolve(value);
  if (!existsSync(path)) throw new Error(`${name} is missing: ${path}`);
  return path;
}
