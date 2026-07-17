import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiteHarnessClient } from "@lite-harness/sdk";
import type { RunEvent } from "@lite-harness/contracts";
import { dockerWorkspaceVolumeName } from "@lite-harness/runtime-docker";

const root = resolve(import.meta.dirname, "..");
const suffix = randomUUID().replaceAll("-", "");
const fixtureRoot = mkdtempSync(join(tmpdir(), "lite-hermes-docker-"));
const dataDir = join(fixtureRoot, "data");
const socketPath = process.platform === "win32"
  ? `\\\\.\\pipe\\lite-hermes-${suffix}`
  : join(fixtureRoot, "manager.sock");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const owner = { appId: `hermes-app-${suffix}`, tenantId: `hermes-tenant-${suffix}`, userId: `hermes-user-${suffix}` };
const agentId = `hermes-agent-${suffix}`;
const workspaceId = `hermes-workspace-${suffix}`;
const appToken = `hermes-app-token-${suffix}`;
const internalToken = `hermes-internal-token-${suffix}`;
const providerKey = process.env.LITE_HARNESS_PROVIDER_API_KEY?.trim() || "sk-hermes-local";
const providerBaseUrl = process.env.LITE_HARNESS_PROVIDER_BASE_URL?.trim() || "http://127.0.0.1:8645/v1";
const provider = process.env.LITE_HARNESS_PROVIDER?.trim() || "openai-compatible";
const modelId = process.env.LITE_HARNESS_MODEL?.trim() || "gpt-5.6-luna";
const offline = process.env.LITE_HARNESS_OFFLINE?.trim() || (provider === "openai-compatible" && /^http:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i.test(providerBaseUrl) ? "true" : "false");
const expectedContent = `Hermes real Docker artifact ${suffix}`;
const runtimeImage = resolveRuntimeImage(process.env.LITE_HARNESS_RUNTIME_IMAGE);
const volume = dockerWorkspaceVolumeName(workspaceId, { ...owner, scopes: [] }, dataDir);
const installationLabel = labelDigest(dataDir);
const managedSeen = new Set<string>();
let manager: ChildProcessWithoutNullStreams | undefined;
let gateway: ChildProcessWithoutNullStreams | undefined;
let managerLogs = "";
let gatewayLogs = "";
let runId: string | undefined;
let observedRun: Record<string, unknown> | undefined;
let observedEvents: RunEvent[] = [];
let processEnvironment: NodeJS.ProcessEnv | undefined;
let credentialInspection = { inspectedContainers: 0, providerCredentialAbsent: true };
let restartVerification: Record<string, unknown> | undefined;
let report: Record<string, unknown>;

try {
  processEnvironment = {
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
    LITE_HARNESS_PORT: String(port),
    LITE_HARNESS_PROVIDER: provider,
    LITE_HARNESS_PROVIDER_BASE_URL: providerBaseUrl,
    LITE_HARNESS_PROVIDER_API_KEY: providerKey,
    LITE_HARNESS_MODEL: modelId,
    LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION: "0",
    LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION: "0",
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_RUNTIME_IMAGE: runtimeImage,
    LITE_HARNESS_MODE: "production",
    LITE_HARNESS_OFFLINE: offline,
    LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT: "false",
    LITE_HARNESS_SNAPSHOT_KEY: Buffer.alloc(32, 7).toString("base64"),
    LITE_HARNESS_ENABLE_PLUGINS: "false",
    LITE_HARNESS_ENABLE_CACHE_CATALOG: "false",
    LITE_HARNESS_CONTEXT_OPTIMIZATION: "false",
  };

  manager = startProcess("manager", join(root, "apps", "manager", "src", "main.ts"), processEnvironment);
  attachProcessLogs(manager, "manager");
  gateway = startProcess("gateway", join(root, "apps", "gateway", "src", "main.ts"), processEnvironment);
  attachProcessLogs(gateway, "gateway");

  await waitForReady(`${baseUrl}/readyz`, [manager, gateway]);
  const client = new LiteHarnessClient({ baseUrl, token: appToken });
  await client.createAgent({
    id: agentId,
    name: "Hermes Docker qualification agent",
    instructions: "Use only the two requested tools and complete the file-and-artifact task exactly.",
    modelCapabilities: ["text", "tools"],
    allowedTools: ["write_file", "artifact_publish"],
    defaultBudget: { maxTurns: 4, maxToolCalls: 4, totalTimeoutMs: 180000, modelIdleTimeoutMs: 120000, commandTimeoutMs: 30000 },
  });
  await client.createWorkspace({ id: workspaceId });
  const created = await client.createRun({
    agent: agentId,
    workspace: workspaceId,
    input: `Use write_file to create hermes-docker-result.txt with exactly this UTF-8 content: ${JSON.stringify(expectedContent)}. Then use artifact_publish on that same path with mediaType text/plain. Use no other tools and do not finish until both calls succeed.`,
    budget: { maxTurns: 4, maxToolCalls: 4, totalTimeoutMs: 180000, modelIdleTimeoutMs: 120000, commandTimeoutMs: 30000 },
  }, `hermes-docker-${suffix}`);
  runId = created.runId;
  const streamedEvents = collectEvents(client, runId);

  let run: Record<string, unknown> | undefined;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    run = await client.getRun(runId) as unknown as Record<string, unknown>;
    observedRun = run;
    for (const id of managedContainerIds(installationLabel)) {
      managedSeen.add(id);
      inspectContainerCredentials(id);
    }
    if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(String(run.status))) break;
    await delay(150);
  }
  if (!run || !["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(String(run.status))) {
    throw new Error(`Hermes Docker run timed out: ${JSON.stringify(run)}`);
  }
  const events = await streamedEvents;
  observedEvents = events;
  const toolRequests = events.filter((event) => event.type === "tool.call.requested").map((event) => event.payload?.name);
  const toolResults = events.filter((event) => event.type === "tool.call.completed").map((event) => event.payload?.ok);
  const usage = events.filter((event) => event.type === "usage.updated").map((event) => event.payload);
  const artifact = events.find((event) => event.type === "artifact.created")?.payload;
  const artifactId = typeof artifact?.artifactId === "string" ? artifact.artifactId : undefined;
  if (run.status !== "SUCCEEDED") throw new Error(`Hermes Docker run failed: ${JSON.stringify({ run, toolRequests, toolResults })}`);
  if (!toolRequests.includes("write_file") || !toolRequests.includes("artifact_publish")) {
    throw new Error(`Hermes did not exercise both required tools: ${JSON.stringify(toolRequests)}`);
  }
  if (toolResults.some((value) => value !== true)) throw new Error(`Hermes Docker tool failure: ${JSON.stringify(toolResults)}`);
  if (!artifactId) throw new Error("Hermes Docker run did not publish an artifact");
  const artifactPayload = await client.downloadArtifact(artifactId);
  const artifactContent = Buffer.from(artifactPayload.data).toString("utf8");
  if (artifactContent !== expectedContent) throw new Error("Published Hermes Docker artifact content did not match the requested bytes");
  const volumeContent = readVolumeFile(volume, runtimeImage);
  if (volumeContent !== expectedContent) throw new Error("The Docker workspace volume did not contain the published artifact bytes");
  if (credentialInspection.inspectedContainers === 0) throw new Error("No live tool container was available for provider-credential inspection");

  await stopProcess(gateway);
  gateway = undefined;
  await stopProcess(manager);
  manager = undefined;
  if (!processEnvironment) throw new Error("Hermes process environment was not initialized");
  manager = startProcess("manager", join(root, "apps", "manager", "src", "main.ts"), processEnvironment);
  attachProcessLogs(manager, "manager");
  gateway = startProcess("gateway", join(root, "apps", "gateway", "src", "main.ts"), processEnvironment);
  attachProcessLogs(gateway, "gateway");
  await waitForReady(`${baseUrl}/readyz`, [manager, gateway]);
  const restartedRun = await client.getRun(runId);
  const restartedArtifact = await client.downloadArtifact(artifactId);
  const replayedAfterRestart = await collectEvents(client, runId);
  if (restartedRun.status !== "SUCCEEDED" || Buffer.from(restartedArtifact.data).toString("utf8") !== expectedContent) {
    throw new Error("Restarted public SDK could not read the completed run and artifact");
  }
  if (replayedAfterRestart.length < events.length || replayedAfterRestart.at(-1)?.sequence !== events.at(-1)?.sequence) {
    throw new Error("Restarted public SDK event replay did not preserve the terminal sequence");
  }
  restartVerification = {
    managerRestarted: true,
    gatewayRestarted: true,
    runStatus: restartedRun.status,
    artifactContentVerified: true,
    replayedEvents: replayedAfterRestart.length,
    terminalSequence: replayedAfterRestart.at(-1)?.sequence ?? null,
  };
  report = {
    schemaVersion: 1,
    kind: "model-docker-vertical",
    sourceCommit: gitOutput(["rev-parse", "HEAD"]),
    sourceDirty: gitOutput(["status", "--porcelain"]).length > 0,
    provider: { route: provider === "openai-compatible" && offline === "true" ? "local-hermes-openai-compatible" : provider, baseUrl: providerBaseUrl, model: modelId, credential: "non-empty-placeholder-only" },
    publicClient: { implementation: "@lite-harness/sdk LiteHarnessClient", eventStream: "SDK SSE replay" },
    runtime: {
      kind: "docker", image: runtimeImage, imagePinned: true, managedContainersObserved: [...managedSeen],
      providerCredentialInspection: credentialInspection,
    },
    run: { id: runId, status: run.status, toolRequests, toolResults, artifactId, eventTypes: events.map((event) => event.type) },
    artifact: { bytes: Buffer.byteLength(artifactContent), sha256: createHash("sha256").update(artifactContent).digest("hex"), contentVerified: true },
    restart: restartVerification,
    usage: { observed: usage.length > 0, records: usage.length > 0 ? usage : "unknown", savingsClaimed: false },
  };
} catch (error) {
  report = {
    schemaVersion: 1,
    kind: "model-docker-vertical",
    sourceCommit: gitOutput(["rev-parse", "HEAD"]),
    sourceDirty: gitOutput(["status", "--porcelain"]).length > 0,
    result: "failed",
    error: error instanceof Error ? error.message : String(error),
    runId,
    run: observedRun,
    events: observedEvents,
    managedContainersObserved: [...managedSeen],
    providerCredentialInspection: credentialInspection,
    restart: restartVerification,
    managerLogs,
    gatewayLogs,
  };
  process.exitCode = 1;
} finally {
  await stopProcess(gateway);
  await stopProcess(manager);
  try { removeManagedContainers(installationLabel); } catch { /* preserve the failure report; cleanup is checked below */ }
  try { removeVolumeIfPresent(volume); } catch { /* preserve the failure report */ }
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* temporary fixture only */ }
  const remaining = managedContainerIds(installationLabel);
  if (remaining.length > 0) {
    report = { ...report, cleanup: { status: "blocked", remainingManagedContainers: remaining } };
    process.exitCode = 1;
  } else {
    report = { ...report, cleanup: { status: "clean", remainingManagedContainers: [] } };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function startProcess(name: string, entry: string, environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (!existsSync(entry)) throw new Error(`${name} entry does not exist: ${entry}`);
  return spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function attachProcessLogs(child: ChildProcessWithoutNullStreams, name: "manager" | "gateway"): void {
  const capture = (chunk: Buffer) => {
    if (name === "manager") managerLogs = `${managerLogs}${chunk.toString()}`.slice(-64 * 1024);
    else gatewayLogs = `${gatewayLogs}${chunk.toString()}`.slice(-64 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
}

function inspectContainerCredentials(containerId: string): void {
  let rendered: string;
  try {
    rendered = execFileSync("docker", ["container", "inspect", "--format", "{{json .Config.Env}}", containerId], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (/no such container|is not running/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
  const env = JSON.parse(rendered) as unknown;
  if (!Array.isArray(env) || env.some((item) => typeof item !== "string")) throw new Error("Tool container environment inspection was invalid");
  credentialInspection.inspectedContainers += 1;
  const values = env as string[];
  if (values.some((item) => item.startsWith("LITE_HARNESS_PROVIDER_API_KEY=") || item.includes(providerKey))) {
    credentialInspection.providerCredentialAbsent = false;
    throw new Error("A real provider credential reached a Docker tool container");
  }
}

async function waitForReady(url: string, processes: ChildProcessWithoutNullStreams[]): Promise<void> {
  const deadline = Date.now() + 45_000;
  let last = "not ready";
  while (Date.now() < deadline) {
    const exited = processes.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (exited) throw new Error(`A live process exited before readiness: ${processes.indexOf(exited)}\n${managerLogs}\n${gatewayLogs}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.text();
      if (response.ok && JSON.parse(body).ok === true) return;
      last = `HTTP ${response.status}: ${body}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await delay(150);
  }
  throw new Error(`Gateway did not become ready: ${last}\n${managerLogs}\n${gatewayLogs}`);
}

async function collectEvents(client: LiteHarnessClient, id: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of client.events(id)) {
    events.push(event);
  }
  return events;
}

function resolveRuntimeImage(configured: string | undefined): string {
  if (configured && /^sha256:[a-f0-9]{64}$/i.test(configured)) return configured;
  const source = configured || "lite-harness/tool-runtime:dev";
  const imageId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", source], { encoding: "utf8", windowsHide: true }).trim();
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) throw new Error(`Runtime image is not pinned: ${imageId}`);
  return imageId;
}

function labelDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function managedContainerIds(installation: string): string[] {
  try {
    return execFileSync("docker", ["ps", "--all", "--filter", "label=lite-harness.managed=true", "--filter", `label=lite-harness.installation=${installation}`, "--format", "{{.ID}}"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch { return []; }
}

function removeManagedContainers(installation: string): void {
  const ids = managedContainerIds(installation);
  if (ids.length > 0) execFileSync("docker", ["rm", "--force", ...ids], { encoding: "utf8", windowsHide: true });
}

function readVolumeFile(name: string, image: string): string {
  return execFileSync("docker", ["run", "--pull=never", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--user", "1000:1000", "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32", "--mount", `type=volume,src=${name},dst=/workspace,readonly`, image, "sh", "-c", "set -eu; cat -- /workspace/hermes-docker-result.txt"], { encoding: "utf8", windowsHide: true });
}

function removeVolumeIfPresent(name: string): void {
  try { execFileSync("docker", ["volume", "inspect", name], { encoding: "utf8", windowsHide: true }); }
  catch { return; }
  execFileSync("docker", ["volume", "rm", name], { encoding: "utf8", windowsHide: true });
}

function gitOutput(args: string[]): string {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim(); }
  catch { return "unknown"; }
}

function stopProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* child may have exited */ }
      } else child.kill("SIGKILL");
      resolveStop();
    }, 10_000);
    timer.unref();
    child.once("close", () => { clearTimeout(timer); resolveStop(); });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Gateway port");
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
