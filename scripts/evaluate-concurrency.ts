import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiteHarnessClient } from "@lite-harness/sdk";
import type { RunEvent, RunRecord } from "@lite-harness/contracts";
import { dockerWorkspaceVolumeName } from "@lite-harness/runtime-docker";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidencePath = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
const provider = process.env.LITE_HARNESS_PROVIDER?.trim();
const model = process.env.LITE_HARNESS_MODEL?.trim();
const providerBaseUrl = process.env.LITE_HARNESS_PROVIDER_BASE_URL?.trim() ?? "https://openrouter.ai/api/v1/";
const isOpenRouter = provider === "openrouter" && model === "openrouter/free" && /^https:\/\/openrouter\.ai\/api\/v1\/?$/i.test(providerBaseUrl);
const isHermes = provider === "openai-compatible" && model === "gpt-5.6-luna" && providerBaseUrl === "http://127.0.0.1:8645/v1";
if (!isOpenRouter && !isHermes) {
  throw new Error("Concurrency qualification requires either OpenRouter openrouter/free or the exact local Hermes gpt-5.6-luna route");
}
if (!process.env.LITE_HARNESS_PROVIDER_API_KEY?.trim()) throw new Error("LITE_HARNESS_PROVIDER_API_KEY must be supplied in the process environment");
const evaluationRoute = isHermes ? "local-hermes-openai-compatible" : "openrouter";

const runtimeImage = immutableImage(process.env.LITE_HARNESS_RUNTIME_IMAGE, "lite-harness/tool-runtime:dev");
const browserImage = immutableImage(process.env.LITE_HARNESS_TEST_BROWSER_IMAGE, "lite-harness/browser-runtime:dev");
const suffix = randomUUID().replaceAll("-", "");
const fixtureRoot = mkdtempSync(join(tmpdir(), `lite-concurrency-${suffix}-`));
const browserServer = createServer((request, response) => {
  if (request.url === "/research") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><main><h1>Concurrency research fixture</h1><p>CONCURRENCY_BROWSER_OK</p></main>");
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("CONCURRENCY_DOWNLOAD_OK");
});

interface Principal { appId: string; tenantId: string; userId: string }
interface UserRuntime {
  label: "user-a" | "user-b";
  root: string;
  dataDir: string;
  socketPath: string;
  appToken: string;
  internalToken: string;
  principal: Principal;
  gatewayPort: number;
  manager?: ChildProcessWithoutNullStreams;
  gateway?: ChildProcessWithoutNullStreams;
  client: LiteHarnessClient;
  managerLogs: string;
  gatewayLogs: string;
}

interface TaskSpec {
  kind: "file" | "coding" | "browser" | "artifact" | "recovery";
  marker: string;
  input: string;
  requiredTools: string[];
  path?: string;
}

interface Observation {
  run: RunRecord;
  events: RunEvent[];
  toolCalls: string[];
  streamError?: string;
}

const users: UserRuntime[] = [];
let fixtureOrigin = "";
let report: Record<string, unknown> = {};
const workspaceIds: string[] = [];

try {
  const browserPort = await listenPort(browserServer);
  fixtureOrigin = `http://host.docker.internal:${browserPort}`;
  users.push(await startUser("user-a", "a"));
  users.push(await startUser("user-b", "b"));
  const metrics = createMetricsSampler(users);
  metrics.start();
  const rounds: Record<string, unknown>[] = [];
  try {
    for (const round of [1, 2]) rounds.push(await runRound(round));
  } finally {
    metrics.stop();
    const isolation = verifyIsolation();
    report = {
      schemaVersion: 1,
      kind: "ten-agent-two-user-concurrency",
      result: rounds.every((round) => round.result === "pass") && isolation.passed ? "pass" : "fail",
      sourceCommit: gitOutput(["rev-parse", "HEAD"]),
      sourceDirty: gitOutput(["status", "--porcelain"]).length > 0,
      provider: { route: evaluationRoute, baseUrl: providerBaseUrl, model: model!, credential: "non-empty-placeholder-only" },
      publicClient: "@lite-harness/sdk LiteHarnessClient",
      users: users.map((user) => ({ label: user.label, appId: user.principal.appId, tenantId: user.principal.tenantId, userId: user.principal.userId })),
      rounds,
      isolation,
      measurements: metrics.report(),
      browser: { image: browserImage, fixtureOrigin },
    };
  }
} catch (error) {
  report = {
    schemaVersion: 1,
    kind: "ten-agent-two-user-concurrency",
    result: "fail",
    sourceCommit: gitOutput(["rev-parse", "HEAD"]),
    sourceDirty: gitOutput(["status", "--porcelain"]).length > 0,
    provider: { route: evaluationRoute, model: model!, credential: "non-empty-placeholder-only" },
    error: error instanceof Error ? error.message : String(error),
    users: users.map((user) => ({ label: user.label, managerLogs: user.managerLogs, gatewayLogs: user.gatewayLogs })),
  };
  process.exitCode = 1;
} finally {
  for (const user of users) {
    await stopProcess(user.gateway);
    await stopProcess(user.manager);
    removeManagedContainers(user.dataDir);
    removeManagedNetworks(user.dataDir);
    removeManagedVolumes(user);
  }
  await closeServer(browserServer);
  const remaining = users.map((user) => ({
    label: user.label,
    containers: managedContainers(user.dataDir),
    networks: managedNetworks(user.dataDir),
    volumes: managedVolumes(user),
  }));
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* temporary fixture only */ }
  const clean = remaining.every((entry) => entry.containers.length === 0 && entry.networks.length === 0 && entry.volumes.length === 0);
  report = { ...report, cleanup: { remaining, status: clean ? "clean" : "blocked" } };
  if (evidencePath) writeFileSync(resolve(root, evidencePath), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function startUser(label: "user-a" | "user-b", short: string): Promise<UserRuntime> {
  const userRoot = mkdtempSync(join(fixtureRoot, `${label}-`));
  const dataDir = join(userRoot, "data");
  const principal = { appId: `concurrency-app-${short}-${suffix}`, tenantId: `concurrency-tenant-${short}-${suffix}`, userId: `concurrency-user-${short}-${suffix}` };
  const gatewayPort = await freePort();
  const user: UserRuntime = {
    label, root: userRoot, dataDir, socketPath: process.platform === "win32" ? `\\\\.\\pipe\\lite-concurrency-${short}-${suffix}` : join(userRoot, "manager.sock"),
    appToken: `lite-concurrency-app-token-${short}-${suffix}`, internalToken: `lite-concurrency-internal-token-${short}-${suffix}`,
    principal, gatewayPort, client: undefined as unknown as LiteHarnessClient, managerLogs: "", gatewayLogs: "",
  };
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    LITE_HARNESS_CONFIG_VERSION: "1", LITE_HARNESS_DATA_DIR: dataDir, LITE_HARNESS_MANAGER_SOCKET: user.socketPath,
    LITE_HARNESS_INTERNAL_TOKEN: user.internalToken, LITE_HARNESS_APP_TOKEN: user.appToken,
    LITE_HARNESS_APP_ID: principal.appId, LITE_HARNESS_TENANT_ID: principal.tenantId, LITE_HARNESS_USER_ID: principal.userId,
    LITE_HARNESS_HOST: "127.0.0.1", LITE_HARNESS_PORT: String(gatewayPort),
    LITE_HARNESS_PROVIDER: provider!, LITE_HARNESS_PROVIDER_BASE_URL: providerBaseUrl,
    LITE_HARNESS_MODEL: model!, LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION: "0", LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION: "0",
    LITE_HARNESS_RUNTIME: "docker", LITE_HARNESS_RUNTIME_IMAGE: runtimeImage, LITE_HARNESS_MODE: "production", LITE_HARNESS_OFFLINE: "false",
    LITE_HARNESS_ENABLE_MEMORY: "false", LITE_HARNESS_REQUIRE_APPROVALS: "false", LITE_HARNESS_CONTEXT_OPTIMIZATION: "false",
    LITE_HARNESS_ENABLE_PLUGINS: "false", LITE_HARNESS_ENABLE_CACHE_CATALOG: "false", LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT: "false",
    LITE_HARNESS_SNAPSHOT_KEY: Buffer.alloc(32, 13).toString("base64"), LITE_HARNESS_BROWSER_IMAGE: browserImage,
    LITE_HARNESS_BROWSER_ALLOWED_ORIGINS: fixtureOrigin, LITE_HARNESS_BROWSER_ALLOW_PRIVATE: "true", LITE_HARNESS_BROWSER_IDLE_MS: "60000",
  };
  user.manager = startProcess("manager", join(root, "apps", "manager", "src", "main.ts"), environment);
  attachLogs(user, user.manager, "manager");
  user.gateway = startProcess("gateway", join(root, "apps", "gateway", "src", "main.ts"), environment);
  attachLogs(user, user.gateway, "gateway");
  await waitForReady(user);
  user.client = new LiteHarnessClient({ baseUrl: `http://127.0.0.1:${gatewayPort}`, token: user.appToken });
  for (let index = 0; index < 5; index += 1) {
    await user.client.createAgent({
      id: `concurrency-${label}-agent-${index}-${suffix}`, name: `${label} concurrent agent ${index}`,
      instructions: "Use the requested tools exactly. Do not stop after planning or after one tool; verify every marker and complete the entire task before replying.",
      modelCapabilities: ["text", "tools"],
      allowedTools: ["write_file", "read_file", "shell_exec", "artifact_publish", "browser_open", "browser_action", "browser_close"],
      defaultBudget: { maxTurns: 10, maxToolCalls: 20, totalTimeoutMs: 300_000, modelIdleTimeoutMs: 120_000, commandTimeoutMs: 45_000 },
    });
  }
  return user;
}

async function runRound(round: number): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  const jobs = users.flatMap((user) => Array.from({ length: 5 }, (_, index) => runConcurrentTask(user, round, index)));
  const results = await Promise.all(jobs);
  return {
    round, result: results.every((result) => result.passed) ? "pass" : "fail", taskCount: results.length,
    passedTasks: results.filter((result) => result.passed).length, failedTasks: results.filter((result) => !result.passed).length,
    latencyMs: Number((performance.now() - startedAt).toFixed(1)), tasks: results,
  };
}

async function runConcurrentTask(user: UserRuntime, round: number, index: number): Promise<Record<string, unknown> & { passed: boolean }> {
  const marker = `CONCURRENCY_${user.label.toUpperCase().replace("-", "_")}_R${round}_A${index}_OK`;
  const task = taskFor(index, marker);
  const workspaceId = `concurrency-round-${round}-slot-${index}`;
  if (!workspaceIds.includes(workspaceId)) workspaceIds.push(workspaceId);
  const startedAt = performance.now();
  try {
    await user.client.createWorkspace({ id: workspaceId });
    const agentId = `concurrency-${user.label}-agent-${index}-${suffix}`;
    const created = await user.client.createRun({
      agent: agentId, workspace: workspaceId, input: task.input,
      budget: { maxTurns: 10, maxToolCalls: 20, totalTimeoutMs: 300_000, modelIdleTimeoutMs: 120_000, commandTimeoutMs: 45_000 },
    }, `concurrency-${user.label}-r${round}-a${index}-${suffix}`);
    const observed = await observeRun(user.client, created.runId);
    const artifactId = observed.events.find((event) => event.type === "artifact.created")?.payload?.artifactId;
    let artifact: Record<string, unknown> | undefined;
    if (typeof artifactId === "string") {
      const downloaded = await user.client.downloadArtifact(artifactId);
      artifact = { artifactId, contentVerified: Buffer.from(downloaded.data).toString("utf8") === task.marker, bytes: downloaded.data.byteLength };
    }
    const workspace = task.path ? inspectWorkspace(user, workspaceId, task.path, task.marker) : undefined;
    const failedCommand = observed.events.some((event) => event.type === "tool.call.completed" && event.payload?.ok === false);
    const requiredToolsPresent = task.requiredTools.every((tool) => observed.toolCalls.includes(tool));
    const markerObserved = observed.events.some((event) => JSON.stringify(event).includes(task.marker));
    const workspaceVerified = task.kind === "artifact" || workspace === undefined || workspace.contentVerified === true;
    const artifactVerified = task.kind !== "artifact" || artifact?.contentVerified === true;
    const passed = observed.run.status === "SUCCEEDED" && requiredToolsPresent && markerObserved &&
      (task.kind !== "recovery" || failedCommand) && artifactVerified && workspaceVerified;
    const reason = observed.run.status !== "SUCCEEDED" ? `terminal status ${observed.run.status}`
      : !requiredToolsPresent ? `missing required tool; observed ${observed.toolCalls.join(",") || "none"}`
      : !markerObserved ? `marker ${task.marker} was not observed in the event stream`
          : !artifactVerified ? "artifact bytes did not match the task marker"
            : !workspaceVerified ? "workspace bytes did not match the task marker"
              : task.kind === "recovery" && !failedCommand ? "the intentional failing command was not observed" : "task evidence verified";
    return {
      label: user.label, round, index, kind: task.kind, marker: task.marker, agentId, workspaceId, runId: created.runId, status: observed.run.status, passed, reason,
      latencyMs: Number((performance.now() - startedAt).toFixed(1)), toolCalls: observed.toolCalls, eventCount: observed.events.length,
      usage: usageSummary(observed.events), workspace, artifact,
      diagnostics: {
        toolCalls: observed.events.filter((event) => event.type === "tool.call.requested").map((event) => ({ name: event.payload?.name, arguments: event.payload?.arguments })),
        toolFailures: observed.events.filter((event) => event.type === "tool.call.completed" && event.payload?.ok === false).map((event) => event.payload),
        assistantMessages: observed.events.filter((event) => event.type === "agent.message.completed").map((event) => String(event.payload?.content ?? "").slice(0, 2_000)),
        terminal: observed.events.filter((event) => ["run.failed", "run.succeeded"].includes(event.type)).map((event) => event.payload),
        streamError: observed.streamError,
      },
    };
  } catch (error) {
    return { label: user.label, round, index, workspaceId, passed: false, latencyMs: Number((performance.now() - startedAt).toFixed(1)), error: error instanceof Error ? error.message : String(error) };
  }
}

function taskFor(index: number, marker: string): TaskSpec {
  if (index === 0) return { kind: "file", marker, path: "concurrency.txt", requiredTools: ["write_file", "read_file"], input: `Create concurrency.txt with exactly ${marker} using write_file, read it back with read_file, and verify the exact bytes before finishing.` };
  if (index === 1) return { kind: "coding", marker, requiredTools: ["write_file", "shell_exec"], input: `Create sum.js with a Node program that prints exactly ${marker}. Run node sum.js with shell_exec and verify the output before finishing.` };
  if (index === 2) return { kind: "browser", marker: "CONCURRENCY_BROWSER_OK", requiredTools: ["browser_open", "browser_action", "browser_close"], input: `Use only browser tools. Call browser_open with {}, navigate with browser_action to ${fixtureOrigin}/research using its sessionId, take a snapshot, verify the page marker CONCURRENCY_BROWSER_OK, and close the session. Complete every tool call before replying.` };
  if (index === 3) return { kind: "artifact", marker, path: "artifact.txt", requiredTools: ["write_file", "artifact_publish"], input: `Write ${marker} exactly to artifact.txt with write_file, then publish artifact.txt with artifact_publish using mediaType text/plain. Verify the artifact result before finishing.` };
  return { kind: "recovery", marker, requiredTools: ["shell_exec"], input: `Use shell_exec to run exit 23 and observe the failure. Then use shell_exec to print exactly ${marker}. Verify both the failure and the successful recovery before finishing.` };
}

async function observeRun(client: LiteHarnessClient, runId: string): Promise<Observation> {
  const events: RunEvent[] = [];
  let streamError: string | undefined;
  const stream = (async () => {
    try { for await (const event of client.events(runId)) events.push(event); }
    catch (error) { streamError = error instanceof Error ? error.message : String(error); }
  })();
  let run = await client.getRun(runId);
  const deadline = Date.now() + 360_000;
  while (!["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status) && Date.now() < deadline) {
    await delay(150);
    run = await client.getRun(runId);
  }
  await Promise.race([stream, delay(2_000)]);
  return { run, events, toolCalls: events.filter((event) => event.type === "tool.call.requested").map((event) => String(event.payload?.name ?? "unknown")), streamError };
}

function inspectWorkspace(user: UserRuntime, workspaceId: string, path: string, expected: string): Record<string, unknown> {
  const volume = dockerWorkspaceVolumeName(workspaceId, { ...user.principal, scopes: [] });
  try {
    const content = execFileSync("docker", ["run", "--pull=never", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32", "--mount", `type=volume,src=${volume},dst=/workspace,readonly`, runtimeImage, "sh", "-c", "set -eu; cat -- \"/workspace/$1\"", "lite-concurrency-read", path], { encoding: "utf8", windowsHide: true }).trimEnd();
    return { checked: true, contentVerified: content === expected, bytes: Buffer.byteLength(content) };
  } catch (error) { return { checked: true, contentVerified: false, error: error instanceof Error ? error.message : String(error) }; }
}

function verifyIsolation(): Record<string, unknown> {
  const pairs = workspaceIds.map((workspaceId) => {
    const a = users.find((user) => user.label === "user-a");
    const b = users.find((user) => user.label === "user-b");
    if (!a || !b) return { workspaceId, passed: false, error: "both users were not started" };
    const volumeA = dockerWorkspaceVolumeName(workspaceId, { ...a.principal, scopes: [] });
    const volumeB = dockerWorkspaceVolumeName(workspaceId, { ...b.principal, scopes: [] });
    return { workspaceId, identicalWorkspaceId: true, distinctVolumes: volumeA !== volumeB, passed: volumeA !== volumeB };
  });
  return { passed: pairs.length === 10 && pairs.every((pair) => pair.passed), pairs };
}

function createMetricsSampler(targets: UserRuntime[]): { start(): void; stop(): void; report(): Record<string, unknown> } {
  let timer: ReturnType<typeof setInterval> | undefined; let samples = 0; let peakRss = 0; let peakContainers = 0;
  const sample = () => { samples += 1; peakRss = Math.max(peakRss, process.memoryUsage().rss); peakContainers = Math.max(peakContainers, targets.reduce((sum, user) => sum + managedContainers(user.dataDir).length, 0)); };
  return { start: () => { sample(); timer = setInterval(sample, 250); timer.unref?.(); }, stop: () => { if (timer) clearInterval(timer); sample(); }, report: () => ({ samples, peakEvaluatorRssBytes: peakRss, peakManagedDockerContainers: peakContainers }) };
}

function attachLogs(user: UserRuntime, child: ChildProcessWithoutNullStreams, role: "manager" | "gateway"): void {
  child.stdout.on("data", (chunk: Buffer) => { if (role === "manager") user.managerLogs = `${user.managerLogs}${chunk.toString()}`.slice(-24 * 1024); else user.gatewayLogs = `${user.gatewayLogs}${chunk.toString()}`.slice(-24 * 1024); });
  child.stderr.on("data", (chunk: Buffer) => { if (role === "manager") user.managerLogs = `${user.managerLogs}${chunk.toString()}`.slice(-24 * 1024); else user.gatewayLogs = `${user.gatewayLogs}${chunk.toString()}`.slice(-24 * 1024); });
}

function startProcess(name: string, entry: string, environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (!existsSync(entry)) throw new Error(`${name} entry does not exist: ${entry}`);
  return spawn(process.execPath, ["--import", "tsx", entry], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

async function waitForReady(user: UserRuntime): Promise<void> {
  const deadline = Date.now() + 60_000; let lastError = "not ready";
  while (Date.now() < deadline) {
    if (user.manager?.exitCode !== null || user.gateway?.exitCode !== null) throw new Error(`Concurrency service exited before readiness: ${user.managerLogs}\n${user.gatewayLogs}`);
    try { const response = await fetch(`http://127.0.0.1:${user.gatewayPort}/readyz`, { signal: AbortSignal.timeout(500) }); if (response.ok && (await response.json() as { ok?: boolean }).ok === true) return; lastError = `HTTP ${response.status}`; }
    catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(100);
  }
  throw new Error(`Concurrency Gateway did not become ready for ${user.label}: ${lastError}`);
}

function stopProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === "win32" && child.pid) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* already stopped */ } return Promise.resolve(); }
  child.kill("SIGTERM");
  return new Promise((resolveStop) => { child.once("close", () => resolveStop()); setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 10_000).unref(); });
}

function managedContainers(installation: string): string[] { try { return execFileSync("docker", ["ps", "--all", "--filter", "label=lite-harness.managed=true", "--filter", `label=lite-harness.installation=${labelDigest(installation)}`, "--format", "{{.ID}}"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean); } catch { return []; } }
function managedNetworks(installation: string): string[] { try { return execFileSync("docker", ["network", "ls", "--filter", "label=lite-harness.managed=true", "--filter", `label=lite-harness.installation=${labelDigest(installation)}`, "--format", "{{.ID}}"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean); } catch { return []; } }
function removeManagedContainers(installation: string): void { const ids = managedContainers(installation); if (ids.length) { try { execFileSync("docker", ["rm", "--force", ...ids], { stdio: "ignore", windowsHide: true }); } catch { /* checked below */ } } }
function removeManagedNetworks(installation: string): void { const ids = managedNetworks(installation); if (ids.length) { try { execFileSync("docker", ["network", "rm", ...ids], { stdio: "ignore", windowsHide: true }); } catch { /* checked below */ } } }
function managedVolumes(user: UserRuntime): string[] { return workspaceIds.map((workspaceId) => dockerWorkspaceVolumeName(workspaceId, { ...user.principal, scopes: [] })).filter((volume) => { try { execFileSync("docker", ["volume", "inspect", volume], { stdio: "ignore", windowsHide: true }); return true; } catch { return false; } }); }
function removeManagedVolumes(user: UserRuntime): void { const volumes = managedVolumes(user); if (volumes.length) { try { execFileSync("docker", ["volume", "rm", "--force", ...volumes], { stdio: "ignore", windowsHide: true }); } catch { /* checked below */ } } }

function usageSummary(events: RunEvent[]): Record<string, number> { return events.filter((event) => event.type === "usage.updated").reduce((sum, event) => ({ inputTokens: sum.inputTokens + numberValue(event.payload?.inputTokens), outputTokens: sum.outputTokens + numberValue(event.payload?.outputTokens), costUsd: sum.costUsd + numberValue(event.payload?.costUsd) }), { inputTokens: 0, outputTokens: 0, costUsd: 0 }); }
function numberValue(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function immutableImage(configured: string | undefined, fallback: string): string { const value = configured?.trim() || fallback; const id = /^sha256:[a-f0-9]{64}$/i.test(value) ? value : execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", value], { encoding: "utf8", windowsHide: true }).trim(); if (!/^sha256:[a-f0-9]{64}$/i.test(id)) throw new Error(`Image is not pinned: ${id}`); return id; }
function gitOutput(args: string[]): string { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim(); } catch { return "unknown"; } }
function labelDigest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
async function listenPort(server: ReturnType<typeof createServer>): Promise<number> { await new Promise<void>((resolveListen, reject) => server.once("error", reject).listen(0, "0.0.0.0", resolveListen)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture did not expose a TCP port"); return address.port; }
async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not allocate port"); const port = address.port; await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); return port; }
async function closeServer(server: ReturnType<typeof createServer>): Promise<void> { if (!server.listening) return; await new Promise<void>((resolveClose) => server.close(() => resolveClose())); }
