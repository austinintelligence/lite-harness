import { rmSync } from "node:fs";
import { join } from "node:path";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { AnthropicProvider } from "@lite-harness/provider-anthropic";
import {
  InMemoryCredentialBroker,
  ModelRegistry,
  RoutedModelGateway,
  type ModelGateway,
} from "@lite-harness/provider-core";
import { OpenAICompatibleProvider } from "@lite-harness/provider-openai-compatible";
import { InMemoryToolRuntime, type ToolRuntime } from "@lite-harness/runtime";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";
import { LocalArtifactStore } from "@lite-harness/workspace";
import { buildManagerServer } from "./server.js";

const dataDir = process.env.LITE_HARNESS_DATA_DIR ?? join(process.cwd(), ".lite-harness");
const socketPath =
  process.env.LITE_HARNESS_MANAGER_SOCKET ??
  (process.platform === "win32" ? "\\\\.\\pipe\\lite-harness-manager" : join(dataDir, "manager.sock"));
const internalToken = requiredEnvironment("LITE_HARNESS_INTERNAL_TOKEN");
const runtime = resolveRuntime();
const store = new SqliteRunStore(join(dataDir, "lite-harness.db"));
const service = new RunService(store, new AgentRunner(resolveModelGateway(), runtime), {
  requiresApproval: process.env.LITE_HARNESS_REQUIRE_APPROVALS === "true"
    ? () => true
    : () => false,
  approvalTimeoutMs: Number.parseInt(process.env.LITE_HARNESS_APPROVAL_TIMEOUT_MS ?? "60000", 10),
});
const reconciled = service.reconcileInterruptedRuns();
if (reconciled > 0) {
  process.stderr.write(`lite-harness manager: reconciled ${reconciled} interrupted run(s)\n`);
}
const artifactStore = new LocalArtifactStore(join(dataDir, "artifacts"));
const app = buildManagerServer({ runService: service, internalToken, artifactStore, logger: true });

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
