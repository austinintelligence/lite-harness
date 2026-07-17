import { join } from "node:path";
import { accessSync, constants, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadManagerConfiguration, type ValidatedManagerConfiguration } from "@lite-harness/config";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import type { IntervalTrigger } from "@lite-harness/automation";
import { RunService } from "@lite-harness/control-plane";
import { OsSecretStore } from "@lite-harness/credential-store";
import { ClaudeCodeGateway, CodexAppServerGateway } from "@lite-harness/delegated-runtime";
import type { SqliteIntegrationStore } from "@lite-harness/integrations";
import {
  LITE_IPC_PROTOCOL_VERSION,
  isTerminalRunStatus,
  type InternalPrincipal,
  type ReadinessDependency,
} from "@lite-harness/contracts";
import type { SqliteMemoryStore } from "@lite-harness/memory-sqlite";
import { AnthropicProvider } from "@lite-harness/provider-anthropic";
import {
  CapabilityBoundModelGateway,
  InMemoryCredentialBroker,
  ModelRegistry,
  officialOpenAiModelProfile,
  ProviderError,
  RoutedModelGateway,
  SingleFlightCredentialBroker,
  type CredentialBroker,
  type ModelCapability,
  type ModelDescriptor,
  type ModelGateway,
  type ModelRunContext,
  type RoutePersistenceHooks,
  type RoutePlan,
} from "@lite-harness/provider-core";
import { OPENAI_COMPATIBLE_PRESETS, OpenAICompatibleProvider, OpenAIResponsesProvider } from "@lite-harness/provider-openai-compatible";
import { ArtifactPublishingRuntime, BrokeredToolRuntime, InMemoryToolRuntime, type ToolExecutionContext, type ToolRuntime } from "@lite-harness/runtime";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { LocalArtifactStore, validateRegisteredBindRoot } from "@lite-harness/workspace";
import { ManagerInstanceLock } from "@lite-harness/operations";
import { JsonlObservabilitySink, StructuredObservability } from "@lite-harness/observability";
import { buildManagerServer } from "./server.js";
import { createDelegatedWorkspaceResolver } from "./delegated-workspace.js";
import { shutdownManagerStages } from "./shutdown.js";
import { configureProductionOptionalSystems } from "./optional-systems.js";

const configuration: ValidatedManagerConfiguration = loadManagerConfiguration();
const { dataDir, socketPath, internalToken } = configuration;
const observability = new StructuredObservability({
  sinks: [new JsonlObservabilitySink(join(dataDir, "manager-observability.jsonl"))],
});
const instanceLock = new ManagerInstanceLock({
  dataDir,
  socketPath,
  protocolVersion: LITE_IPC_PROTOCOL_VERSION,
});
await instanceLock.acquire();
const databasePath = join(dataDir, "lite-harness.db");
const store = new SqliteRunStore(databasePath);
const snapshotRootKey = await artifactEncryptionRootKey(dataDir, configuration.mode);
const artifactStore = new LocalArtifactStore(
  join(dataDir, "artifacts"),
  snapshotRootKey,
);
const validateExecutionLease = (params: ToolExecutionContext): boolean => hasActiveWorkspaceFence(store, params);
const baseRuntime = resolveRuntime(store, configuration.runtime, validateExecutionLease);
if (baseRuntime instanceof DockerToolRuntime) {
  const reapedContainers = await baseRuntime.reconcileContainers();
  if (reapedContainers > 0) {
    process.stderr.write(`lite-harness manager: reaped ${reapedContainers} interrupted Docker container(s)\n`);
  }
}
const brokeredRuntime = new BrokeredToolRuntime(baseRuntime);
const runtime = new ArtifactPublishingRuntime(
  brokeredRuntime,
  artifactStore,
  16 * 1024 * 1024,
  validateExecutionLease,
);
const memoryStore = configuration.memoryEnabled
  ? new (await import("@lite-harness/memory-sqlite")).SqliteMemoryStore(join(dataDir, "memory.db"))
  : undefined;
const modelGateway = resolveModelGateway(
  configuration.provider,
  createDelegatedWorkspaceResolver(store),
  { onRoutePlan: persistRunRoutePlan, onUsage: persistRunModelUsage },
);
// ContextOptimizationGate, skills, MCP, plugins, snapshots, and caches are
// composed here so they share the production run/tool lifecycle.
const optionalSystems = await configureProductionOptionalSystems({
  dataDir,
  modelId: process.env.LITE_HARNESS_MODEL?.trim() || configuration.provider,
  runtime: brokeredRuntime,
  offline: configuration.offline,
  ...(baseRuntime instanceof DockerToolRuntime ? { dockerRuntime: baseRuntime } : {}),
  workspaceStore: store,
  snapshotKey: snapshotRootKey,
  ...(memoryStore ? { memoryStore } : {}),
  featureFlags: {
    contextOptimization: configuration.contextOptimizationEnabled,
    plugins: configuration.pluginsEnabled,
    cacheCatalog: configuration.cacheCatalogEnabled,
  },
});
const automaticWorkspaceCheckpoint = optionalSystems.workspaceLifecycle;
const runtimeImageDigest = baseRuntime instanceof DockerToolRuntime ? requiredEnvironment("LITE_HARNESS_RUNTIME_IMAGE") : undefined;
const runSnapshotConfiguration = {
  runtimeProfile: {
    id: configuration.runtime,
    ...(runtimeImageDigest ? { imageDigest: runtimeImageDigest } : {}),
    policyDigest: createHash("sha256").update(JSON.stringify({
      runtime: configuration.runtime,
      memory: configuration.runtimeMemory,
      cpus: configuration.runtimeCpus,
      pids: configuration.runtimePids,
      profile: process.env.LITE_HARNESS_TOOL_PROFILE ?? "node-profile",
    })).digest("hex"),
  },
  networkPolicy: {
    id: configuration.offline
      ? "offline-loopback-provider-tools-no-egress-v1"
      : baseRuntime instanceof DockerToolRuntime ? "docker-tool-network-none-v1" : "development-in-memory-v1",
    digest: createHash("sha256").update(JSON.stringify({
      offline: configuration.offline,
      toolRuntime: baseRuntime instanceof DockerToolRuntime ? "docker:--network=none:--pull=never:v1" : "in-memory:no-egress:v1",
      provider: configuration.offline ? "fake-or-loopback-only:redirect-manual:v1" : "configured-provider-policy:v1",
    })).digest("hex"),
  },
  plugins: (runId: string) => optionalSystems.pluginSnapshotsForRun(runId),
  releaseRun: (runId: string) => optionalSystems.releasePluginRun(runId),
  credentialProfileIds: ["snapshot.root", "browser.profile-root"],
};
const integrationModule = process.env.LITE_HARNESS_WEBHOOK_SECRET ? await import("@lite-harness/integrations") : undefined;
const integrationStore = integrationModule ? new integrationModule.SqliteIntegrationStore(join(dataDir, "integrations.db")) : undefined;
const service = new RunService(store, new AgentRunner(modelGateway, runtime, 8, optionalSystems.context), {
  requiresApproval: configuration.approvalsRequired
    ? () => true
    : () => false,
  approvalTimeoutMs: configuration.approvalTimeoutMs,
  approvalRouteGeneration: configuredApprovalRouteGeneration(configuration.provider),
  ...(automaticWorkspaceCheckpoint ? { workspaceLifecycle: automaticWorkspaceCheckpoint } : {}),
  makeWorkspaceColdAfterCheckpoint: configuration.workspaceColdAfterCheckpoint,
  runSnapshot: runSnapshotConfiguration,
  observability,
});
const integrationRouter = integrationStore && integrationModule ? new integrationModule.InboundRunRouter(integrationStore, async ({ binding, envelope, sessionId }) => {
  const created = service.createRun({
    agent: binding.agentId,
    workspace: binding.workspaceId,
    session: sessionId,
    input: integrationModule.composeInboundPrompt(envelope),
    idempotencyKey: `webhook:${envelope.accountId}:${envelope.deliveryId}`,
    principal: {
      appId: binding.appId, tenantId: binding.tenantId, userId: binding.userId,
      scopes: ["runs:create", "integrations:ingress"],
    },
  });
  return created.runId;
}) : undefined;
const brokeredCapabilities = await configureBrokeredTools(brokeredRuntime, service, memoryStore, artifactStore);
if (integrationStore) configureWebhookBinding(integrationStore);
const reconciled = service.reconcileInterruptedRuns();
if (reconciled > 0) {
  process.stderr.write(`lite-harness manager: reconciled ${reconciled} interrupted run(s)\n`);
}
const app = buildManagerServer({
  runService: service, internalToken, instanceId: instanceLock.owner.instanceId, artifactStore,
  readWorkspaceArtifact: ({ runId, workspaceId, attemptId, fencingToken, principal, path, maxBytes }) => {
    if (!brokeredRuntime.readWorkspaceArtifact) throw new Error("The configured runtime cannot read workspace artifacts");
    return brokeredRuntime.readWorkspaceArtifact({
      runId, workspaceId, attemptId, fencingToken, principal, allowedTools: ["artifact_publish"],
      call: { id: `artifact-read-${randomUUID()}`, name: "artifact_read", arguments: { path } },
      signal: AbortSignal.timeout(30_000), path, maxBytes,
    });
  },
  productionReadinessChecks: createProductionReadinessChecks(store, baseRuntime, configuration),
  ...(optionalSystems.pluginLifecycle ? { pluginLifecycle: optionalSystems.pluginLifecycle } : {}),
  ...(integrationStore && integrationRouter ? { integrationStore, integrationRouter, webhookSecret: async (accountId: string) => {
    const configuredAccount = process.env.LITE_HARNESS_WEBHOOK_ACCOUNT ?? "primary";
    const secret = process.env.LITE_HARNESS_WEBHOOK_SECRET;
    return accountId === configuredAccount && secret ? Buffer.from(secret) : undefined;
  } } : {}),
  logger: false,
  observability,
});
const automation = await configureAutomation(service, dataDir);
const integrationDelivery = integrationStore ? await configureIntegrationDelivery(service, integrationStore) : undefined;
app.addHook("onClose", async () => {
  await shutdownManagerStages([
    { name: "automation", stop: () => automation?.stop() },
    { name: "integration-delivery", stop: () => integrationDelivery?.stop() },
    { name: "run-service", stop: () => service.shutdown(configuration.shutdownTimeoutMs) },
    { name: "brokered-capabilities", stop: () => brokeredCapabilities.stop() },
    { name: "optional-systems", stop: () => optionalSystems.stop() },
    { name: "memory-store", stop: () => memoryStore?.close() },
    { name: "integration-store", stop: () => integrationStore?.close() },
    { name: "run-store", stop: () => store.close() },
    { name: "instance-lock", stop: () => instanceLock.release() },
  ]);
});

async function configureBrokeredTools(
  runtime: BrokeredToolRuntime,
  runs: RunService,
  memories: SqliteMemoryStore | undefined,
  artifacts: LocalArtifactStore,
): Promise<{ stop(): Promise<void> }> {
  if (memories) {
    runtime.register("memory_add", async (params) => {
      const principal = requireToolPrincipal(params.runId, params.principal);
      const markdown = toolString(params.call.arguments.markdown, "markdown");
      const entry = memories.add(principal.tenantId, params.workspaceId, markdown);
      return { callId: params.call.id, ok: true, content: JSON.stringify(entry), metadata: { memoryId: entry.id } };
    });
    runtime.register("memory_search", async (params) => {
      const principal = requireToolPrincipal(params.runId, params.principal);
      const query = toolString(params.call.arguments.query, "query");
      const limit = toolInteger(params.call.arguments.limit, "limit", 1, 100, 20);
      const entries = memories.search(principal.tenantId, params.workspaceId, query, limit);
      return { callId: params.call.id, ok: true, content: JSON.stringify(entries), metadata: { count: entries.length } };
    });
    runtime.register("memory_get", async (params) => {
      const principal = requireToolPrincipal(params.runId, params.principal);
      const id = toolString(params.call.arguments.id, "id");
      const entry = memories.get(principal.tenantId, params.workspaceId, id);
      return entry
        ? { callId: params.call.id, ok: true, content: JSON.stringify(entry), metadata: { memoryId: entry.id } }
        : { callId: params.call.id, ok: false, content: "Memory not found" };
    });
  }
  runtime.register("subagent_spawn", async (params) => {
    const principal = requireToolPrincipal(params.runId, params.principal);
    const parent = runs.getRun(params.runId as string);
    if (!parent || parent.tenantId !== principal.tenantId || parent.userId !== principal.userId) throw new Error("Parent run ownership check failed");
    const created = runs.createChildRun({
      parentRunId: parent.id,
      agent: toolString(params.call.arguments.agent, "agent"),
      input: toolString(params.call.arguments.input, "input"),
      idempotencyKey: params.call.id,
      ...(params.call.arguments.budget && typeof params.call.arguments.budget === "object"
        ? { budget: toolBudget(params.call.arguments.budget as Record<string, unknown>) }
        : {}),
    });
    return { callId: params.call.id, ok: true, content: JSON.stringify(created), metadata: { childRunId: created.runId } };
  });
  runtime.register("subagent_wait", async (params) => {
    requireToolPrincipal(params.runId, params.principal);
    const childRunId = toolString(params.call.arguments.runId, "runId");
    const timeoutMs = toolInteger(params.call.arguments.timeoutMs, "timeoutMs", 100, 300_000, 300_000);
    const child = await runs.waitForChildRun(params.runId as string, childRunId, timeoutMs);
    const summary = [...runs.listEvents(child.id)].reverse().find((event) => event.type === "agent.message.completed")?.payload.content;
    return {
      callId: params.call.id, ok: child.status === "SUCCEEDED",
      content: typeof summary === "string" ? summary : JSON.stringify({ runId: child.id, status: child.status }),
      metadata: { childRunId: child.id, status: child.status },
    };
  });
  runtime.register("subagent_cancel", async (params) => {
    requireToolPrincipal(params.runId, params.principal);
    const childRunId = toolString(params.call.arguments.runId, "runId");
    const child = runs.getRun(childRunId);
    if (!child || child.parentRunId !== params.runId) throw new Error("Child run does not belong to the parent");
    const cancelled = runs.cancelRun(child.id);
    return { callId: params.call.id, ok: true, content: JSON.stringify({ runId: child.id, status: cancelled?.status }) };
  });
  const callbackUrl = process.env.LITE_HARNESS_APP_CALLBACK_URL;
  const callbackSecret = process.env.LITE_HARNESS_APP_CALLBACK_SECRET;
  if (callbackUrl && callbackSecret) {
    const { SignedAppCallbackClient } = await import("@lite-harness/integrations");
    const callbacks = new SignedAppCallbackClient(callbackUrl, async () => callbackSecret);
    runtime.register("app_callback", async (params) => {
      const principal = requireToolPrincipal(params.runId, params.principal);
      const action = toolString(params.call.arguments.action, "action");
      const result = await callbacks.invoke({ appId: principal.appId, action, input: params.call.arguments.input, idempotencyKey: params.call.id }, params.signal);
      return { callId: params.call.id, ok: true, content: JSON.stringify(result) };
    });
  } else if (callbackUrl || callbackSecret) {
    throw new Error("LITE_HARNESS_APP_CALLBACK_URL and LITE_HARNESS_APP_CALLBACK_SECRET must be configured together");
  }
  const browserImage = process.env.LITE_HARNESS_BROWSER_IMAGE;
  if (!browserImage) return { stop: async () => undefined };
  const allowedOrigins = (process.env.LITE_HARNESS_BROWSER_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const remoteCdpEndpoint = process.env.LITE_HARNESS_BROWSER_REMOTE_CDP;
  const profileId = process.env.LITE_HARNESS_BROWSER_PROFILE_ID;
  const profileKey = profileId ? await resolveStoredKey("LITE_HARNESS_BROWSER_PROFILE_KEY", "browser.profile-root") : undefined;
  const { configureManagerBrowserCapability } = await import("./browser-capability.js");
  return await configureManagerBrowserCapability({
    runtime,
    artifacts,
    dataDir,
    image: browserImage,
    allowedOrigins,
    allowPrivateNetworks: configuration.browserPrivateNetworksAllowed,
    idleTtlMs: configuration.browserIdleMs,
    ...(remoteCdpEndpoint ? { remoteCdpEndpoint } : {}),
    ...(profileId && profileKey ? { profileId, profileKey } : {}),
  });
}

async function resolveStoredKey(environmentName: string, profileId: string): Promise<Buffer> {
  const secrets = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
  const value = process.env[environmentName]?.trim() || await secrets.get(profileId);
  if (!value) throw new Error(`Configure ${environmentName} or OS credential ${profileId}`);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${environmentName} must be a base64-encoded 32-byte key`);
  return key;
}

function requireToolPrincipal(runId: string | undefined, principal: InternalPrincipal | undefined): InternalPrincipal {
  if (!runId || !principal) throw new Error("Brokered tool requires an owned run context");
  return principal;
}

function toolString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000_000) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function toolInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} is invalid`);
  return value as number;
}

function toolBudget(value: Record<string, unknown>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!["maxTurns", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxCostUsd", "totalTimeoutMs", "modelIdleTimeoutMs", "commandTimeoutMs"].includes(key) ||
        typeof item !== "number" || !Number.isFinite(item) || item < 0) throw new Error("Subagent budget is invalid");
    output[key] = item;
  }
  return output;
}

try {
  await app.listen({ path: socketPath });
  await instanceLock.secureEndpoint();
} catch (error) {
  await instanceLock.release();
  throw error;
}
installShutdownHandlers(app);

function resolveRuntime(
  runStore: SqliteRunStore,
  kind: "fake" | "docker",
  validateExecutionLease: (params: ToolExecutionContext) => boolean,
): ToolRuntime {
  if (kind === "fake") {
    process.stderr.write("lite-harness manager: using development in-memory tool runtime\n");
    return new InMemoryToolRuntime();
  }
  if (kind !== "docker") {
    throw new Error(`Unsupported LITE_HARNESS_RUNTIME: ${kind}`);
  }
  const image = requiredEnvironment("LITE_HARNESS_RUNTIME_IMAGE");
  return new DockerToolRuntime({
    image,
    installationId: dataDir,
    containerStore: runStore,
    memory: configuration.runtimeMemory,
    cpus: configuration.runtimeCpus,
    pidsLimit: configuration.runtimePids,
    workspaceQuotaBytes: configuration.workspaceQuotaBytes,
    validateExecutionLease,
    resolveRegisteredWorkspace: (workspaceId, principal) => {
      if (!principal) return undefined;
      const workspace = runStore.getWorkspace(workspaceId, principal);
      return workspace?.mode === "registered-bind" && workspace.registeredPath
        ? validateRegisteredBindRoot(workspace.registeredPath)
        : undefined;
    },
  });
}

function hasActiveWorkspaceFence(store: SqliteRunStore, params: ToolExecutionContext): boolean {
  if (!params.runId || !params.attemptId || !params.principal || params.fencingToken === undefined) return false;
  const run = store.getRun(params.runId);
  if (!run || run.workspaceId !== params.workspaceId || run.appId !== params.principal.appId ||
      run.tenantId !== params.principal.tenantId || run.userId !== params.principal.userId) return false;
  const attempt = store.listRunAttempts(run.id).findLast((item) => item.status === "RUNNING");
  const lease = store.getWorkspaceLease(run.workspaceId, run.id);
  return attempt?.id === params.attemptId && lease?.fencingToken === params.fencingToken &&
    store.validateWorkspaceLease(lease);
}

function createProductionReadinessChecks(
  runStore: SqliteRunStore,
  toolRuntime: ToolRuntime,
  config: typeof configuration,
): () => Promise<Record<string, ReadinessDependency>> {
  return async () => {
    const database = runStore.readiness();
    const disk = diskReadiness(config.dataDir);
    const provider = await providerReadiness(config.provider, config.mode);
    const snapshotKey = await snapshotKeyReadiness(config.dataDir, config.mode);
    if (toolRuntime instanceof DockerToolRuntime) {
      const docker = await toolRuntime.doctor();
      const image = await toolRuntime.imageReadiness();
      return {
        database,
        disk,
        provider,
        snapshotKey,
        runtime: docker.available ? { ok: true } : { ok: false, reason: "docker-unavailable" },
        image: image.ok ? { ok: true } : { ok: false, reason: "runtime-image-unavailable" },
      };
    }
    return {
      database,
      disk,
      provider,
      snapshotKey,
      runtime: config.mode === "development" ? { ok: true } : { ok: false, reason: "fake-runtime-forbidden" },
      image: config.mode === "development" ? { ok: true } : { ok: false, reason: "runtime-image-required" },
    };
  };
}

function diskReadiness(path: string): ReadinessDependency {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    const disk = statfsSync(path);
    return disk.bavail * disk.bsize >= 1024 * 1024 * 1024
      ? { ok: true }
      : { ok: false, reason: "insufficient-free-space" };
  } catch {
    return { ok: false, reason: "data-directory-unavailable" };
  }
}

async function providerReadiness(provider: string, mode: "development" | "production"): Promise<ReadinessDependency> {
  if (provider === "fake") return mode === "development" ? { ok: true } : { ok: false, reason: "fake-provider-forbidden" };
  if (provider === "codex" || provider === "claude") {
    if (provider === "codex") {
      try {
        const pricing = configuredModelPricing(process.env.LITE_HARNESS_MODEL);
        if (pricing.inputUsdPerMillion === undefined || pricing.outputUsdPerMillion === undefined) {
          return { ok: false, reason: "model-pricing-missing" };
        }
      } catch {
        return { ok: false, reason: "model-pricing-invalid" };
      }
    }
    const command = provider === "codex"
      ? process.env.LITE_HARNESS_CODEX_COMMAND ?? "codex"
      : process.env.LITE_HARNESS_CLAUDE_COMMAND ?? "claude";
    return await executableReadiness(command);
  }
  try {
    const pricing = configuredModelPricing(process.env.LITE_HARNESS_MODEL);
    if (pricing.inputUsdPerMillion === undefined || pricing.outputUsdPerMillion === undefined) {
      return { ok: false, reason: "model-pricing-missing" };
    }
  } catch {
    return { ok: false, reason: "model-pricing-invalid" };
  }
  const kind = process.env.LITE_HARNESS_CREDENTIAL_STORE ?? "environment";
  if (kind === "environment") return process.env.LITE_HARNESS_PROVIDER_API_KEY?.trim()
    ? { ok: true }
    : { ok: false, reason: "provider-credential-missing" };
  if (kind !== "os") return { ok: false, reason: "credential-store-unsupported" };
  try {
    const profileId = process.env.LITE_HARNESS_CREDENTIAL_PROFILE ?? `${provider}_default`;
    const secret = await new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") }).get(profileId);
    return secret ? { ok: true } : { ok: false, reason: "provider-credential-missing" };
  } catch {
    return { ok: false, reason: "credential-store-unavailable" };
  }
}

async function snapshotKeyReadiness(path: string, mode: "development" | "production"): Promise<ReadinessDependency> {
  if (mode === "development") return { ok: true };
  const configured = process.env.LITE_HARNESS_SNAPSHOT_KEY;
  if (configured) return validBase64Key(configured)
    ? { ok: true }
    : { ok: false, reason: "snapshot-key-invalid" };
  try {
    const secret = await new OsSecretStore({ windowsPath: join(path, "credentials.dpapi.json") }).get("snapshot.root");
    return secret && validBase64Key(secret)
      ? { ok: true }
      : { ok: false, reason: "snapshot-key-missing" };
  } catch {
    return { ok: false, reason: "snapshot-key-store-unavailable" };
  }
}

async function artifactEncryptionRootKey(path: string, mode: "development" | "production"): Promise<Buffer> {
  const configured = process.env.LITE_HARNESS_SNAPSHOT_KEY;
  if (configured) {
    if (!validBase64Key(configured)) throw new Error("LITE_HARNESS_SNAPSHOT_KEY must be a base64-encoded 32-byte key");
    return Buffer.from(configured, "base64");
  }
  try {
    const secret = await new OsSecretStore({ windowsPath: join(path, "credentials.dpapi.json") }).get("snapshot.root");
    if (secret) {
      if (!validBase64Key(secret)) throw new Error("Stored snapshot.root must be a base64-encoded 32-byte key");
      return Buffer.from(secret, "base64");
    }
  } catch (error) {
    if (mode === "production") throw error;
  }
  if (mode === "production") throw new Error("Encrypted artifact storage requires snapshot.root or LITE_HARNESS_SNAPSHOT_KEY");
  const developmentKeyPath = join(path, "development-artifact.key");
  try {
    const existing = readFileSync(developmentKeyPath, "utf8").trim();
    if (!validBase64Key(existing)) throw new Error("Development artifact key is invalid");
    return Buffer.from(existing, "base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = randomBytes(32);
  try {
    writeFileSync(developmentKeyPath, generated.toString("base64"), { flag: "wx", mode: 0o600 });
    process.stderr.write("lite-harness manager: created a local development-only artifact key\n");
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readFileSync(developmentKeyPath, "utf8").trim();
    if (!validBase64Key(raced)) throw new Error("Development artifact key is invalid");
    return Buffer.from(raced, "base64");
  }
}

function executableReadiness(command: string): Promise<ReadinessDependency> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
      signal: AbortSignal.timeout(3_000),
    });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok ? { ok: true } : { ok: false, reason: "provider-command-unavailable" });
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function validBase64Key(value: string): boolean {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function configuredApprovalRouteGeneration(provider: string): string {
  const explicit = process.env.LITE_HARNESS_ROUTE_GENERATION?.trim();
  if (explicit) return explicit;
  let baseUrl = process.env.LITE_HARNESS_PROVIDER_BASE_URL?.trim() ?? "provider-default";
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    baseUrl = parsed.toString();
  } catch {
    // Named provider presets do not require a URL.
  }
  const descriptor = JSON.stringify({
    version: 1,
    provider,
    model: process.env.LITE_HARNESS_MODEL?.trim() || "provider-default",
    baseUrl,
  });
  return `route-${createHash("sha256").update(descriptor).digest("hex")}`;
}

function resolveModelGateway(
  provider: string,
  workspacePathForRun: ReturnType<typeof createDelegatedWorkspaceResolver>,
  hooks: RoutePersistenceHooks,
): ModelGateway {
  if (provider === "fake") return new CapabilityBoundModelGateway({
    id: "fake", providerId: "fake", transport: "direct", credentialProfileId: "fake",
    capabilities: ["text", "tools", "vision", "json", "reasoning", "delegated-agent"],
    contextWindow: 128_000, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
    provenance: "static", enabled: true,
  }, new FakeModelGateway(), hooks);

  if (provider === "codex") {
    const modelId = process.env.LITE_HARNESS_MODEL?.trim() || "codex-delegated";
    const pricing = configuredModelPricing(modelId);
    return new CapabilityBoundModelGateway(delegatedDescriptor(modelId, "codex", pricing), new CodexAppServerGateway({
      workspacePathForRun,
      ...pricing,
      ...(process.env.LITE_HARNESS_CODEX_COMMAND ? { command: process.env.LITE_HARNESS_CODEX_COMMAND } : {}),
      ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
      ...(process.env.LITE_HARNESS_MODEL ? { model: process.env.LITE_HARNESS_MODEL } : {}),
    }), hooks);
  }

  if (provider === "claude") {
    const maxBudget = configuration.delegatedMaxBudgetUsd;
    const modelId = process.env.LITE_HARNESS_MODEL?.trim() || "claude-delegated";
    const pricing = configuredModelPricing(modelId);
    return new CapabilityBoundModelGateway(delegatedDescriptor(modelId, "claude", pricing), new ClaudeCodeGateway({
      workspacePathForRun,
      ...pricing,
      ...(process.env.LITE_HARNESS_CLAUDE_COMMAND ? { command: process.env.LITE_HARNESS_CLAUDE_COMMAND } : {}),
      ...(process.env.LITE_HARNESS_MODEL ? { model: process.env.LITE_HARNESS_MODEL } : {}),
      allowedTools: (process.env.LITE_HARNESS_DELEGATED_TOOLS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      ...(maxBudget !== undefined ? { maxBudgetUsd: maxBudget } : {}),
    }), hooks);
  }

  const credentialProfileId = process.env.LITE_HARNESS_CREDENTIAL_PROFILE ?? `${provider}_default`;
  const broker = resolveCredentialBroker(credentialProfileId);

  const preset = OPENAI_COMPATIBLE_PRESETS[provider as keyof typeof OPENAI_COMPATIBLE_PRESETS];
  if (preset || provider === "openai-compatible") {
    const baseUrl = preset?.baseUrl ?? requiredEnvironment("LITE_HARNESS_PROVIDER_BASE_URL");
    const providerId = preset?.providerId ?? "openai-compatible";
    const allowedOrigins = preset?.allowedOrigins ?? [new URL(baseUrl).origin];
    const modelId = requiredEnvironment("LITE_HARNESS_MODEL");
    const registry = new ModelRegistry(configuredDirectModels({
      id: modelId, providerId, credentialProfileId, capabilities: ["text", "tools", "json"],
      contextWindow: configuration.modelContext ?? 128_000,
    }));
    return new RoutedModelGateway(
      registry,
      [provider === "openai"
        ? new OpenAIResponsesProvider()
        : new OpenAICompatibleProvider({ providerId, baseUrl, allowedOrigins })],
      broker,
      hooks,
    );
  }

  if (provider === "anthropic") {
    const baseUrl = process.env.LITE_HARNESS_PROVIDER_BASE_URL ?? "https://api.anthropic.com/v1/";
    const modelId = requiredEnvironment("LITE_HARNESS_MODEL");
    const registry = new ModelRegistry(configuredDirectModels({
      id: modelId, providerId: "anthropic", credentialProfileId, capabilities: ["text", "tools", "vision"],
      contextWindow: configuration.modelContext ?? 200_000,
    }));
    return new RoutedModelGateway(
      registry,
      [new AnthropicProvider({ baseUrl, allowedOrigins: [new URL(baseUrl).origin] })],
      broker,
      hooks,
    );
  }

  throw new Error(`Unsupported LITE_HARNESS_PROVIDER: ${provider}`);
}

function delegatedDescriptor(
  modelId: string,
  providerId: string,
  pricing: { inputUsdPerMillion?: number; outputUsdPerMillion?: number },
): ModelDescriptor {
  return {
    id: modelId, providerId, transport: "delegated", credentialProfileId: `${providerId}_delegated`,
    capabilities: ["text", "tools", "reasoning", "delegated-agent"], contextWindow: 128_000,
    ...pricing, provenance: "operator", enabled: true,
  };
}

function configuredDirectModels(defaults: {
  id: string;
  providerId: string;
  credentialProfileId: string;
  capabilities: readonly ModelCapability[];
  contextWindow: number;
}): ModelDescriptor[] {
  const officialDefault = officialOpenAiModelProfile(defaults.id);
  const pricing = configuredModelPricing(defaults.id);
  const defaultCapabilities = officialDefault
    ? [...new Set([...defaults.capabilities, "vision" as const])]
    : [...defaults.capabilities];
  const defaultContextWindow = officialDefault?.contextWindow ?? defaults.contextWindow;
  const raw = process.env.LITE_HARNESS_MODEL_CATALOG?.trim();
  if (!raw) return [{ ...defaults, capabilities: defaultCapabilities, contextWindow: defaultContextWindow, transport: "direct", ...pricing, provenance: "operator", enabled: true }];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("LITE_HARNESS_MODEL_CATALOG must be valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 256) throw new Error("LITE_HARNESS_MODEL_CATALOG must be a non-empty bounded array");
  const allowed = new Set<ModelCapability>(["text", "tools", "vision", "json", "reasoning", "delegated-agent"]);
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Model catalog entry ${index} must be an object`);
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const capabilities = Array.isArray(record.capabilities) ? [...new Set(record.capabilities)] : [];
    const contextWindow = record.contextWindow ?? defaults.contextWindow;
    if (!id || id.length > 256 || /[\0\r\n]/.test(id)) throw new Error(`Model catalog entry ${index} id is invalid`);
    if (!capabilities.length || !capabilities.every((item): item is ModelCapability => typeof item === "string" && allowed.has(item as ModelCapability))) {
      throw new Error(`Model catalog entry ${index} capabilities are invalid`);
    }
    if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) < 1) throw new Error(`Model catalog entry ${index} context window is invalid`);
    const input = record.inputUsdPerMillion;
    const output = record.outputUsdPerMillion;
    if ((input === undefined) !== (output === undefined) || (input !== undefined && (!Number.isFinite(input) || (input as number) < 0)) ||
        (output !== undefined && (!Number.isFinite(output) || (output as number) < 0))) {
      throw new Error(`Model catalog entry ${index} pricing is invalid`);
    }
    return {
      id, providerId: defaults.providerId, transport: "direct" as const,
      credentialProfileId: defaults.credentialProfileId, capabilities,
      contextWindow: contextWindow as number,
      ...(input === undefined ? configuredModelPricing(id) : { inputUsdPerMillion: input as number, outputUsdPerMillion: output as number }),
      provenance: "operator" as const, enabled: record.enabled === undefined ? true : record.enabled === true,
    };
  });
}

function persistRunRoutePlan(
  context: ModelRunContext,
  plan: RoutePlan,
  requiredCapabilities: readonly ModelCapability[],
): void {
  store.persistRunRoutePlan({
    runId: context.runId, attemptId: context.attemptId, routePlanId: plan.id,
    registryGeneration: plan.registryGeneration,
    requiredCapabilities: [...requiredCapabilities],
    selectedModelId: plan.selected.id, selectedProviderId: plan.selected.providerId,
    selectedCredentialProfileId: plan.selected.credentialProfileId,
    fallbackModelIds: plan.fallbacks.map((model) => model.id), createdAt: plan.createdAt,
  });
}

function persistRunModelUsage(
  context: ModelRunContext,
  plan: RoutePlan,
  model: ModelDescriptor,
  usage: {
    inputTokens: number; outputTokens: number; cachedInputTokens?: number;
    cacheWriteInputTokens?: number; imageInputTokens?: number; costUsd?: number;
  },
): void {
  const priceSnapshot = model.inputUsdPerMillion !== undefined && model.outputUsdPerMillion !== undefined ? {
    currency: "USD" as const, source: model.pricingSource ?? "operator",
    inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion,
    ...(model.cachedInputUsdPerMillion === undefined ? {} : { cachedInputUsdPerMillion: model.cachedInputUsdPerMillion }),
    ...(model.cacheWriteInputUsdPerMillion === undefined ? {} : { cacheWriteInputUsdPerMillion: model.cacheWriteInputUsdPerMillion }),
    ...(model.imageInputUsdPerMillion === undefined ? {} : { imageInputUsdPerMillion: model.imageInputUsdPerMillion }),
    ...(model.longContextThresholdTokens === undefined ? {} : { longContextThresholdTokens: model.longContextThresholdTokens }),
    ...(model.longContextInputMultiplier === undefined ? {} : { longContextInputMultiplier: model.longContextInputMultiplier }),
    ...(model.longContextOutputMultiplier === undefined ? {} : { longContextOutputMultiplier: model.longContextOutputMultiplier }),
  } : undefined;
  store.persistRunModelUsage({
    runId: context.runId, attemptId: context.attemptId, routePlanId: plan.id,
    modelId: model.id, providerId: model.providerId,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.imageInputTokens === undefined ? {} : { imageInputTokens: usage.imageInputTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(priceSnapshot ? { priceSnapshot } : {}),
    recordedAt: new Date().toISOString(),
  });
}

function resolveCredentialBroker(profileId: string): CredentialBroker {
  const kind = process.env.LITE_HARNESS_CREDENTIAL_STORE ?? "environment";
  if (kind === "environment") {
    const broker = new InMemoryCredentialBroker();
    broker.set(profileId, { authorizationHeader: `Bearer ${requiredEnvironment("LITE_HARNESS_PROVIDER_API_KEY")}` });
    return broker;
  }
  if (kind !== "os") throw new Error(`Unsupported LITE_HARNESS_CREDENTIAL_STORE: ${kind}`);
  const secrets = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
  const load = async (id: string) => {
    const secret = await secrets.get(id);
    return secret ? { authorizationHeader: `Bearer ${secret}` } : undefined;
  };
  return new SingleFlightCredentialBroker({
    load,
    refresh: async (id) => {
      const material = await load(id);
      if (!material) throw new ProviderError("credential_missing", `Credential profile is unavailable: ${id}`, false);
      return material;
    },
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function configuredModelPricing(modelId?: string): Pick<ModelDescriptor,
  "inputUsdPerMillion" | "outputUsdPerMillion" | "cachedInputUsdPerMillion" |
  "cacheWriteInputUsdPerMillion" | "imageInputUsdPerMillion" | "longContextThresholdTokens" |
  "longContextInputMultiplier" | "longContextOutputMultiplier" | "pricingSource"
> {
  const input = process.env.LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION?.trim();
  const output = process.env.LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION?.trim();
  if (!input && !output) return modelId ? officialOpenAiModelProfile(modelId) ?? {} : {};
  if (!input || !output) throw new Error("Both model input and output prices are required when either is configured");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(output)) {
    throw new Error("Model prices must be finite non-negative USD-per-million-token values");
  }
  const inputUsdPerMillion = Number(input);
  const outputUsdPerMillion = Number(output);
  if (!Number.isFinite(inputUsdPerMillion) || inputUsdPerMillion < 0 ||
      inputUsdPerMillion > 1_000_000 || !Number.isFinite(outputUsdPerMillion) || outputUsdPerMillion < 0 || outputUsdPerMillion > 1_000_000) {
    throw new Error("Model prices must be finite non-negative USD-per-million-token values");
  }
  if (inputUsdPerMillion === 0 && outputUsdPerMillion === 0) {
    return {
      inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0,
      cacheWriteInputUsdPerMillion: 0, imageInputUsdPerMillion: 0, pricingSource: "operator-zero-rate",
    };
  }
  return { inputUsdPerMillion, outputUsdPerMillion, pricingSource: "operator" };
}

function installShutdownHandlers(server: { close(): Promise<void> }): void {
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`lite-harness manager: received ${signal}, shutting down\n`);
    void server.close().catch((error) => {
      process.stderr.write(`lite-harness manager: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function configureWebhookBinding(integrations: SqliteIntegrationStore): void {
  if (!process.env.LITE_HARNESS_WEBHOOK_SECRET) return;
  integrations.bind({
    connectorId: "webhook",
    accountId: process.env.LITE_HARNESS_WEBHOOK_ACCOUNT ?? "primary",
    senderExternalId: process.env.LITE_HARNESS_WEBHOOK_SENDER ?? "*",
    appId: process.env.LITE_HARNESS_WEBHOOK_APP_ID ?? "app_local",
    tenantId: process.env.LITE_HARNESS_WEBHOOK_TENANT_ID ?? "tenant_local",
    userId: process.env.LITE_HARNESS_WEBHOOK_USER_ID ?? "user_local",
    agentId: process.env.LITE_HARNESS_WEBHOOK_AGENT_ID ?? "coder",
    workspaceId: process.env.LITE_HARNESS_WEBHOOK_WORKSPACE_ID ?? "webhook",
    sessionPrefix: process.env.LITE_HARNESS_WEBHOOK_SESSION_PREFIX ?? "hook",
  });
}

async function configureIntegrationDelivery(runs: RunService, integrations: SqliteIntegrationStore): Promise<{ stop(): void } | undefined> {
  const callbackUrl = process.env.LITE_HARNESS_WEBHOOK_REPLY_URL;
  const callbackSecret = process.env.LITE_HARNESS_WEBHOOK_REPLY_SECRET ?? process.env.LITE_HARNESS_WEBHOOK_SECRET;
  if (!callbackUrl || !callbackSecret) return undefined;
  const { DeliveryCoordinator, WebhookCallbackConnector } = await import("@lite-harness/integrations");
  const account = process.env.LITE_HARNESS_WEBHOOK_ACCOUNT ?? "primary";
  const adapter = new WebhookCallbackConnector(async (accountId) => {
    if (accountId !== account) throw new Error("Webhook callback account is not configured");
    return { url: callbackUrl, secret: callbackSecret };
  });
  const coordinator = new DeliveryCoordinator(integrations, `manager_${process.pid}`, new Map([[adapter.connectorId, adapter]]), async (runId) => {
    const run = runs.getRun(runId);
    if (!run) return { terminal: true, errorCode: "run_missing" };
    if (!isTerminalRunStatus(run.status)) return { terminal: false };
    const completed = [...runs.listEvents(run.id)].reverse().find((event) => event.type === "agent.message.completed")?.payload.content;
    return typeof completed === "string"
      ? { terminal: true, text: completed }
      : { terminal: true, errorCode: run.errorCode ?? "run_no_reply" };
  });
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void coordinator.tick().catch((error) => {
      process.stderr.write(`lite-harness delivery: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => { ticking = false; });
  }, 500);
  timer.unref();
  process.stderr.write("lite-harness manager: enabled durable webhook reply delivery\n");
  return { stop: () => clearInterval(timer) };
}

interface ConfiguredSchedule extends Record<string, unknown> {
  id: string;
  intervalMs: number;
  nextFireAt?: number;
  jitterMs?: number;
  oneShot?: boolean;
  agent: string;
  workspace: string;
  session?: string;
  input: string;
  principal: { appId: string; tenantId: string; userId: string };
  missedRunPolicy?: "skip" | "catch-up";
  timeZone?: string;
  localTime?: string;
}

async function configureAutomation(runService: RunService, root: string): Promise<{ stop(): void } | undefined> {
  const raw = process.env.LITE_HARNESS_SCHEDULES_JSON;
  if (!raw) return undefined;
  const { SchedulerEngine, SqliteTriggerStore, nextDailyOccurrence } = await import("@lite-harness/automation");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LITE_HARNESS_SCHEDULES_JSON must be an array");
  const schedules = parsed.map(validateSchedule);
  const triggerStore = new SqliteTriggerStore(join(root, "automation.db"));
  const owner = `manager_${process.pid}`;
  const scheduler = new SchedulerEngine(triggerStore, owner, async (trigger) => {
    const payload = trigger.payload as unknown as ConfiguredSchedule;
    runService.createRun({
      agent: payload.agent,
      workspace: payload.workspace,
      session: payload.session ?? `schedule_${payload.id}`,
      input: payload.input,
      idempotencyKey: `schedule:${trigger.id}:${trigger.nextFireAt}`,
      principal: { ...payload.principal, scopes: ["runs:create", "automation:execute"] },
    });
  });
  for (const schedule of schedules) {
    const trigger: IntervalTrigger = {
      id: schedule.id, intervalMs: schedule.intervalMs,
      nextFireAt: schedule.nextFireAt ?? (schedule.timeZone && schedule.localTime
        ? nextDailyOccurrence(schedule.timeZone, schedule.localTime, Date.now())
        : Date.now() + schedule.intervalMs),
      payload: schedule,
      ...(schedule.jitterMs === undefined ? {} : { jitterMs: schedule.jitterMs }),
      ...(schedule.oneShot === undefined ? {} : { oneShot: schedule.oneShot }),
      ...(schedule.missedRunPolicy === undefined ? {} : { missedRunPolicy: schedule.missedRunPolicy }),
      ...(schedule.timeZone === undefined ? {} : { timeZone: schedule.timeZone }),
      ...(schedule.localTime === undefined ? {} : { localTime: schedule.localTime }),
    };
    triggerStore.ensure(trigger);
  }
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void scheduler.tick().catch((error) => {
      process.stderr.write(`lite-harness scheduler: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => { ticking = false; });
  }, 1_000);
  timer.unref();
  process.stderr.write(`lite-harness manager: enabled ${schedules.length} durable schedule(s)\n`);
  return { stop: () => { clearInterval(timer); triggerStore.close(); } };
}

function validateSchedule(value: unknown): ConfiguredSchedule {
  if (!value || typeof value !== "object") throw new Error("Each configured schedule must be an object");
  const record = value as Record<string, unknown>;
  const principal = record.principal as Record<string, unknown> | undefined;
  for (const field of ["id", "agent", "workspace", "input"] as const) {
    if (typeof record[field] !== "string" || !(record[field] as string).trim()) throw new Error(`Schedule ${field} is required`);
  }
  if (record.oneShot !== undefined && typeof record.oneShot !== "boolean") throw new Error("Schedule oneShot must be boolean");
  if (record.missedRunPolicy !== undefined && !["skip", "catch-up"].includes(record.missedRunPolicy as string)) {
    throw new Error("Schedule missedRunPolicy must be skip or catch-up");
  }
  if ((record.timeZone === undefined) !== (record.localTime === undefined)) throw new Error("Schedule timeZone and localTime must be configured together");
  if (record.timeZone !== undefined) {
    if (typeof record.timeZone !== "string" || typeof record.localTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(record.localTime)) {
      throw new Error("Schedule timeZone/localTime is invalid");
    }
    try { new Intl.DateTimeFormat("en-US", { timeZone: record.timeZone }).format(0); }
    catch { throw new Error("Schedule timeZone is invalid"); }
  }
  if (record.jitterMs !== undefined && (!Number.isSafeInteger(record.jitterMs) || (record.jitterMs as number) < 0)) {
    throw new Error("Schedule jitterMs is invalid");
  }
  if (record.nextFireAt !== undefined && (!Number.isSafeInteger(record.nextFireAt) || (record.nextFireAt as number) < 0)) {
    throw new Error("Schedule nextFireAt is invalid");
  }
  if (record.intervalMs === undefined && record.timeZone !== undefined) record.intervalMs = 86_400_000;
  if (!Number.isSafeInteger(record.intervalMs) || (record.intervalMs as number) < (record.oneShot === true ? 0 : 1_000)) {
    throw new Error("Schedule intervalMs is invalid");
  }
  if (!principal || ["appId", "tenantId", "userId"].some((field) => typeof principal[field] !== "string" || !(principal[field] as string).trim())) {
    throw new Error("Schedule principal is invalid");
  }
  return record as unknown as ConfiguredSchedule;
}
