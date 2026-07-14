import { rmSync } from "node:fs";
import { join } from "node:path";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { SchedulerEngine, SqliteTriggerStore, type IntervalTrigger } from "@lite-harness/automation";
import { RunService } from "@lite-harness/control-plane";
import { ClaudeCodeGateway, CodexAppServerGateway } from "@lite-harness/delegated-runtime";
import { InboundRunRouter, SqliteIntegrationStore } from "@lite-harness/integrations";
import { AnthropicProvider } from "@lite-harness/provider-anthropic";
import {
  InMemoryCredentialBroker,
  ModelRegistry,
  RoutedModelGateway,
  type ModelGateway,
} from "@lite-harness/provider-core";
import { OpenAICompatibleProvider } from "@lite-harness/provider-openai-compatible";
import { ArtifactPublishingRuntime, InMemoryToolRuntime, type ToolRuntime } from "@lite-harness/runtime";
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
const runtime = new ArtifactPublishingRuntime(resolveRuntime(), artifactStore);
const integrationStore = new SqliteIntegrationStore(join(dataDir, "integrations.db"));
const service = new RunService(store, new AgentRunner(resolveModelGateway(), runtime), {
  requiresApproval: process.env.LITE_HARNESS_REQUIRE_APPROVALS === "true"
    ? () => true
    : () => false,
  approvalTimeoutMs: Number.parseInt(process.env.LITE_HARNESS_APPROVAL_TIMEOUT_MS ?? "60000", 10),
});
const integrationRouter = new InboundRunRouter(integrationStore, async ({ binding, envelope, sessionId }) => {
  const created = service.createRun({
    agent: binding.agentId,
    workspace: binding.workspaceId,
    session: sessionId,
    input: envelope.text,
    idempotencyKey: `webhook:${envelope.accountId}:${envelope.deliveryId}`,
    principal: {
      appId: binding.appId, tenantId: binding.tenantId, userId: binding.userId,
      scopes: ["runs:create", "integrations:ingress"],
    },
  });
  return created.runId;
});
configureWebhookBinding(integrationStore);
const reconciled = service.reconcileInterruptedRuns();
if (reconciled > 0) {
  process.stderr.write(`lite-harness manager: reconciled ${reconciled} interrupted run(s)\n`);
}
const app = buildManagerServer({
  runService: service, internalToken, artifactStore, integrationStore, integrationRouter,
  webhookSecret: async (accountId) => {
    const configuredAccount = process.env.LITE_HARNESS_WEBHOOK_ACCOUNT ?? "primary";
    const secret = process.env.LITE_HARNESS_WEBHOOK_SECRET;
    return accountId === configuredAccount && secret ? Buffer.from(secret) : undefined;
  },
  logger: true,
});
const automation = configureAutomation(service, dataDir);
app.addHook("onClose", async () => {
  automation?.stop();
  integrationStore.close();
  store.close();
});

if (process.platform !== "win32") {
  rmSync(socketPath, { force: true });
}

await app.listen({ path: socketPath });

function resolveRuntime(): ToolRuntime {
  const kind = process.env.LITE_HARNESS_RUNTIME ?? "fake";
  if (kind === "fake") {
    process.stderr.write("lite-harness manager: using development in-memory tool runtime\n");
    return new InMemoryToolRuntime();
  }
  if (kind !== "docker") {
    throw new Error(`Unsupported LITE_HARNESS_RUNTIME: ${kind}`);
  }
  const image = requiredEnvironment("LITE_HARNESS_RUNTIME_IMAGE");
  return new DockerToolRuntime({ image });
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
  const apiKey = requiredEnvironment("LITE_HARNESS_PROVIDER_API_KEY");
  const broker = new InMemoryCredentialBroker();
  broker.set(credentialProfileId, { authorizationHeader: `Bearer ${apiKey}` });

  if (provider === "openai" || provider === "openai-compatible") {
    const baseUrl = process.env.LITE_HARNESS_PROVIDER_BASE_URL ?? "https://api.openai.com/v1/";
    const providerId = provider === "openai" ? "openai" : "openai-compatible";
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
      [new OpenAICompatibleProvider({ providerId, baseUrl, allowedOrigins: [new URL(baseUrl).origin] })],
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
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
      nextFireAt: schedule.nextFireAt ?? Date.now() + schedule.intervalMs,
      payload: schedule,
      ...(schedule.jitterMs === undefined ? {} : { jitterMs: schedule.jitterMs }),
      ...(schedule.oneShot === undefined ? {} : { oneShot: schedule.oneShot }),
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
  if (record.jitterMs !== undefined && (!Number.isSafeInteger(record.jitterMs) || (record.jitterMs as number) < 0)) {
    throw new Error("Schedule jitterMs is invalid");
  }
  if (record.nextFireAt !== undefined && (!Number.isSafeInteger(record.nextFireAt) || (record.nextFireAt as number) < 0)) {
    throw new Error("Schedule nextFireAt is invalid");
  }
  if (!Number.isSafeInteger(record.intervalMs) || (record.intervalMs as number) < (record.oneShot === true ? 0 : 1_000)) {
    throw new Error("Schedule intervalMs is invalid");
  }
  if (!principal || ["appId", "tenantId", "userId"].some((field) => typeof principal[field] !== "string" || !(principal[field] as string).trim())) {
    throw new Error("Schedule principal is invalid");
  }
  return record as unknown as ConfiguredSchedule;
}
