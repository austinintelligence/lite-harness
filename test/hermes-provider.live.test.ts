import { describe, expect, it } from "vitest";
import { AgentRunner } from "@lite-harness/agent-runtime";
import { InMemoryCredentialBroker, ModelRegistry, RoutedModelGateway } from "@lite-harness/provider-core";
import { OpenAICompatibleProvider } from "@lite-harness/provider-openai-compatible";
import { InMemoryToolRuntime } from "@lite-harness/runtime";

if (process.env.LITE_HARNESS_LIVE_MODEL_TEST !== "hermes") {
  throw new Error("Hermes live tests must be run through pnpm test:hermes");
}

describe("local Hermes model route", () => {
  it("runs a minimal harness inference through gpt-5.6-luna", async () => {
    const baseUrl = required("LITE_HARNESS_PROVIDER_BASE_URL");
    const modelId = required("LITE_HARNESS_MODEL");
    expect(process.env.LITE_HARNESS_PROVIDER).toBe("openai-compatible");
    expect(baseUrl).toBe("http://127.0.0.1:8645/v1");
    expect(modelId).toBe("gpt-5.6-luna");
    const credentialProfileId = process.env.LITE_HARNESS_CREDENTIAL_PROFILE ?? "hermes_local";
    const credentials = new InMemoryCredentialBroker();
    credentials.set(credentialProfileId, { authorizationHeader: `Bearer ${required("LITE_HARNESS_PROVIDER_API_KEY")}` });
    const registry = new ModelRegistry([{
      id: modelId, providerId: "openai-compatible", transport: "direct", credentialProfileId,
      capabilities: ["text"], contextWindow: 128_000, provenance: "operator", enabled: true,
    }]);
    const gateway = new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text"] }),
      [new OpenAICompatibleProvider({ providerId: "openai-compatible", baseUrl, allowedOrigins: [new URL(baseUrl).origin] })],
      credentials,
    );
    const completed: string[] = [];
    await new AgentRunner(gateway, new InMemoryToolRuntime(), 1).run({
      input: "Reply with exactly HERMES_LITE_OK and do not call tools.", workspaceId: "hermes-live",
      maxTurns: 1, modelIdleTimeoutMs: 120_000,
      onEvent: (event) => {
        if (event.type === "agent.message.completed" && typeof event.payload.content === "string") completed.push(event.payload.content);
      },
    });
    expect(completed.join("")).toContain("HERMES_LITE_OK");
  }, 180_000);
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Hermes live test`);
  return value;
}
