import { rmSync } from "node:fs";
import { join } from "node:path";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { SchedulerEngine, SqliteTriggerStore, nextDailyOccurrence, type IntervalTrigger } from "@lite-harness/automation";
import {
  DockerBrowserDriver, EncryptedBrowserProfileStore, ManagedBrowserBroker, type BrowserAction, type BrowserOwner,
} from "@lite-harness/browser";
import { RunService } from "@lite-harness/control-plane";
import { OsSecretStore } from "@lite-harness/credential-store";
import { ClaudeCodeGateway, CodexAppServerGateway } from "@lite-harness/delegated-runtime";
import {
  DeliveryCoordinator, InboundRunRouter, SignedAppCallbackClient, SqliteIntegrationStore, WebhookCallbackConnector, composeInboundPrompt,
} from "@lite-harness/integrations";
import { isTerminalRunStatus, type InternalPrincipal } from "@lite-harness/contracts";
import type { SqliteMemoryStore } from "@lite-harness/memory-sqlite";
import { AnthropicProvider } from "@lite-harness/provider-anthropic";
import {
  InMemoryCredentialBroker,
  ModelRegistry,
  ProviderError,
  RoutedModelGateway,
  SingleFlightCredentialBroker,
  type CredentialBroker,
  type ModelGateway,
} from "@lite-harness/provider-core";
import { OPENAI_COMPATIBLE_PRESETS, OpenAICompatibleProvider } from "@lite-harness/provider-openai-compatible";
import { ArtifactPublishingRuntime, BrokeredToolRuntime, InMemoryToolRuntime, type ToolRuntime } from "@lite-harness/runtime";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { LocalArtifactStore } from "@lite-harness/workspace";
import { buildManagerServer } from "./server.js";

const dataDir = process.env.LITE_HARNESS_DATA_DIR ?? join(process.cwd(), ".lite-harness");
const socketPath =
  process.env.LITE_HARNESS_MANAGER_SOCKET ??
  (process.platform === "win32" ? "\\\\.\\pipe\\lite-harness-manager" : join(dataDir, "manager.sock"));
const internalToken = requiredEnvironment("LITE_HARNESS_INTERNAL_TOKEN");
const store = new SqliteRunStore(join(dataDir, "lite-harness.db"));
const artifactStore = new LocalArtifactStore(join(dataDir, "artifacts"));
const brokeredRuntime = new BrokeredToolRuntime(resolveRuntime(store));
const runtime = new ArtifactPublishingRuntime(brokeredRuntime, artifactStore);
const integrationStore = process.env.LITE_HARNESS_WEBHOOK_SECRET
  ? new SqliteIntegrationStore(join(dataDir, "integrations.db"))
  : undefined;
const memoryStore = process.env.LITE_HARNESS_ENABLE_MEMORY === "true"
  ? new (await import("@lite-harness/memory-sqlite")).SqliteMemoryStore(join(dataDir, "memory.db"))
  : undefined;
const service = new RunService(store, new AgentRunner(resolveModelGateway(), runtime), {
  requiresApproval: process.env.LITE_HARNESS_REQUIRE_APPROVALS === "true"
    ? () => true
    : () => false,
  approvalTimeoutMs: Number.parseInt(process.env.LITE_HARNESS_APPROVAL_TIMEOUT_MS ?? "60000", 10),
});
const integrationRouter = integrationStore ? new InboundRunRouter(integrationStore, async ({ binding, envelope, sessionId }) => {
  const created = service.createRun({
    agent: binding.agentId,
    workspace: binding.workspaceId,
    session: sessionId,
    input: composeInboundPrompt(envelope),
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
  runService: service, internalToken, artifactStore,
  ...(integrationStore && integrationRouter ? { integrationStore, integrationRouter, webhookSecret: async (accountId: string) => {
    const configuredAccount = process.env.LITE_HARNESS_WEBHOOK_ACCOUNT ?? "primary";
    const secret = process.env.LITE_HARNESS_WEBHOOK_SECRET;
    return accountId === configuredAccount && secret ? Buffer.from(secret) : undefined;
  } } : {}),
  logger: true,
});
const automation = configureAutomation(service, dataDir);
const integrationDelivery = integrationStore ? configureIntegrationDelivery(service, integrationStore) : undefined;
app.addHook("onClose", async () => {
  automation?.stop();
  integrationDelivery?.stop();
  await brokeredCapabilities.stop();
  memoryStore?.close();
  integrationStore?.close();
  store.close();
  if (process.platform !== "win32") rmSync(socketPath, { force: true });
});

if (process.platform !== "win32") {
  rmSync(socketPath, { force: true });
}

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
  const browser = new ManagedBrowserBroker(() => new DockerBrowserDriver({
    image: browserImage,
    ...(remoteCdpEndpoint ? { remoteCdpEndpoint } : {}),
  }), {
    idleTtlMs: toolInteger(Number(process.env.LITE_HARNESS_BROWSER_IDLE_MS ?? 60_000), "browser idle", 1_000, 3_600_000, 60_000),
    ...(profileKey ? { profileStore: new EncryptedBrowserProfileStore(join(dataDir, "browser-profiles"), profileKey) } : {}),
  });
  runtime.register("browser_open", async (params) => {
    const principal = requireToolPrincipal(params.runId, params.principal);
    const owner: BrowserOwner = { ...principal, runId: params.runId as string };
    const sessionId = browser.create(owner, {
      ...(allowedOrigins.length ? { allowedOrigins } : {}),
      allowPrivateNetworks: process.env.LITE_HARNESS_BROWSER_ALLOW_PRIVATE === "true",
    }, profileId);
    return { callId: params.call.id, ok: true, content: JSON.stringify({ sessionId }), metadata: { sessionId } };
  });
  runtime.register("browser_action", async (params) => {
    const principal = requireToolPrincipal(params.runId, params.principal);
    const sessionId = toolString(params.call.arguments.sessionId, "sessionId");
    const action = validateBrowserAction(params.call.arguments.command);
    const owner: BrowserOwner = { ...principal, runId: params.runId as string };
    const result = await browser.execute(sessionId, owner, action, params.signal);
    if (result.artifact) {
      const record = artifacts.publish({
        runId: params.runId as string, workspaceId: params.workspaceId, principal,
        path: `browser/${result.artifact.name}`, mediaType: result.artifact.mediaType,
        data: Buffer.from(result.artifact.dataBase64, "base64"),
      });
      return { callId: params.call.id, ok: true, content: JSON.stringify({ ...result, artifact: { ...record } }), metadata: { artifactId: record.id } };
    }
    return { callId: params.call.id, ok: true, content: JSON.stringify(result) };
  });
  runtime.register("browser_close", async (params) => {
    const principal = requireToolPrincipal(params.runId, params.principal);
    const sessionId = toolString(params.call.arguments.sessionId, "sessionId");
    await browser.close(sessionId, { ...principal, runId: params.runId as string });
    return { callId: params.call.id, ok: true, content: JSON.stringify({ sessionId, closed: true }) };
  });
  return { stop: async () => browser.closeAll() };
}

async function resolveStoredKey(environmentName: string, profileId: string): Promise<Buffer> {
  const secrets = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
  const value = process.env[environmentName]?.trim() || await secrets.get(profileId);
  if (!value) throw new Error(`Configure ${environmentName} or OS credential ${profileId}`);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${environmentName} must be a base64-encoded 32-byte key`);
  return key;
}

function validateBrowserAction(value: unknown): BrowserAction {
  if (!value || typeof value !== "object") throw new Error("Browser command must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["navigate", "snapshot", "click", "type", "select", "hover", "keyboard", "wait", "screenshot", "pdf", "upload",
    "scroll", "drag", "tabs", "new_tab", "switch_tab", "close_tab", "inspect", "back", "forward", "reload"]);
  if (typeof record.action !== "string" || !allowed.has(record.action)) throw new Error("Browser action is invalid");
  return record as unknown as BrowserAction;
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

await app.listen({ path: socketPath });
installShutdownHandlers(app);

function resolveRuntime(runStore: SqliteRunStore): ToolRuntime {
  const kind = process.env.LITE_HARNESS_RUNTIME ?? "fake";
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
    workspaceQuotaBytes: Number.parseInt(process.env.LITE_HARNESS_WORKSPACE_QUOTA_BYTES ?? String(1024 * 1024 * 1024), 10),
    resolveRegisteredWorkspace: (workspaceId) => {
      const workspace = runStore.getWorkspace(workspaceId);
      return workspace?.mode === "registered-bind" ? workspace.registeredPath : undefined;
    },
  });
}

function resolveModelGateway(): ModelGateway {
  const provider = process.env.LITE_HARNESS_PROVIDER ?? "fake";
  if (provider === "fake") return new FakeModelGateway();

  if (provider === "codex") {
    return new CodexAppServerGateway({
      cwd: process.env.LITE_HARNESS_DELEGATED_CWD ?? process.cwd(),
      ...(process.env.LITE_HARNESS_CODEX_COMMAND ? { command: process.env.LITE_HARNESS_CODEX_COMMAND } : {}),
      ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
      ...(process.env.LITE_HARNESS_MODEL ? { model: process.env.LITE_HARNESS_MODEL } : {}),
    });
  }

  if (provider === "claude") {
    const maxBudget = process.env.LITE_HARNESS_DELEGATED_MAX_BUDGET_USD;
    return new ClaudeCodeGateway({
      cwd: process.env.LITE_HARNESS_DELEGATED_CWD ?? process.cwd(),
      ...(process.env.LITE_HARNESS_CLAUDE_COMMAND ? { command: process.env.LITE_HARNESS_CLAUDE_COMMAND } : {}),
      ...(process.env.LITE_HARNESS_MODEL ? { model: process.env.LITE_HARNESS_MODEL } : {}),
      allowedTools: (process.env.LITE_HARNESS_DELEGATED_TOOLS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      ...(maxBudget ? { maxBudgetUsd: Number.parseFloat(maxBudget) } : {}),
    });
  }

  const credentialProfileId = process.env.LITE_HARNESS_CREDENTIAL_PROFILE ?? `${provider}_default`;
  const broker = resolveCredentialBroker(credentialProfileId);

  const preset = OPENAI_COMPATIBLE_PRESETS[provider as keyof typeof OPENAI_COMPATIBLE_PRESETS];
  if (preset || provider === "openai-compatible") {
    const baseUrl = preset?.baseUrl ?? requiredEnvironment("LITE_HARNESS_PROVIDER_BASE_URL");
    const providerId = preset?.providerId ?? "openai-compatible";
    const allowedOrigins = preset?.allowedOrigins ?? [new URL(baseUrl).origin];
    const modelId = requiredEnvironment("LITE_HARNESS_MODEL");
    const registry = new ModelRegistry([
      {
        id: modelId,
        providerId,
        transport: "direct",
        credentialProfileId,
        capabilities: ["text", "tools", "json"],
        contextWindow: Number.parseInt(process.env.LITE_HARNESS_MODEL_CONTEXT ?? "128000", 10),
        provenance: "operator",
        enabled: true,
      },
    ]);
    return new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text"] }),
      [new OpenAICompatibleProvider({ providerId, baseUrl, allowedOrigins })],
      broker,
    );
  }

  if (provider === "anthropic") {
    const baseUrl = process.env.LITE_HARNESS_PROVIDER_BASE_URL ?? "https://api.anthropic.com/v1/";
    const modelId = requiredEnvironment("LITE_HARNESS_MODEL");
    const registry = new ModelRegistry([
      {
        id: modelId,
        providerId: "anthropic",
        transport: "direct",
        credentialProfileId,
        capabilities: ["text", "tools", "vision"],
        contextWindow: Number.parseInt(process.env.LITE_HARNESS_MODEL_CONTEXT ?? "200000", 10),
        provenance: "operator",
        enabled: true,
      },
    ]);
    return new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text"] }),
      [new AnthropicProvider({ baseUrl, allowedOrigins: [new URL(baseUrl).origin] })],
      broker,
    );
  }

  throw new Error(`Unsupported LITE_HARNESS_PROVIDER: ${provider}`);
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

function configureIntegrationDelivery(runs: RunService, integrations: SqliteIntegrationStore): { stop(): void } | undefined {
  const callbackUrl = process.env.LITE_HARNESS_WEBHOOK_REPLY_URL;
  const callbackSecret = process.env.LITE_HARNESS_WEBHOOK_REPLY_SECRET ?? process.env.LITE_HARNESS_WEBHOOK_SECRET;
  if (!callbackUrl || !callbackSecret) return undefined;
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

function configureAutomation(runService: RunService, root: string): { stop(): void } | undefined {
  const raw = process.env.LITE_HARNESS_SCHEDULES_JSON;
  if (!raw) return undefined;
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
