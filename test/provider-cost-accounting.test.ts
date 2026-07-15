import { describe, expect, it } from "vitest";
import { AgentRunner } from "@lite-harness/agent-runtime";
import { CodexAppServerGateway } from "@lite-harness/delegated-runtime";
import {
  InMemoryCredentialBroker,
  ModelRegistry,
  officialOpenAiModelProfile,
  ProviderError,
  RoutedModelGateway,
  type ModelDescriptor,
  type ModelEvent,
  type ProviderAdapter,
  type ModelGateway,
} from "@lite-harness/provider-core";
import { InMemoryToolRuntime } from "@lite-harness/runtime";

function model(id: string, providerId: string, priced: boolean): ModelDescriptor {
  return {
    id,
    providerId,
    transport: "direct",
    credentialProfileId: `${providerId}-credential`,
    capabilities: ["text"],
    contextWindow: 128_000,
    ...(priced ? { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } : {}),
    provenance: "operator",
    enabled: true,
  };
}

function context(maxCostUsd: number) {
  return {
    runId: "run_cost",
    attemptId: "attempt_cost",
    workspaceId: "workspace_cost",
    principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
    fencingToken: 1,
    maxCostUsd,
  };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("provider cost accounting", () => {
  it("applies the official Luna, Terra, and Sol text, image, cache, and output price snapshot", async () => {
    expect(officialOpenAiModelProfile("gpt-5.6-luna")).toMatchObject({
      inputUsdPerMillion: 1, imageInputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1,
      cacheWriteInputUsdPerMillion: 1.25, outputUsdPerMillion: 6,
    });
    expect(officialOpenAiModelProfile("gpt-5.6-terra")).toMatchObject({ inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 });
    expect(officialOpenAiModelProfile("gpt-5.6-sol")).toMatchObject({ inputUsdPerMillion: 5, outputUsdPerMillion: 30 });
    const descriptor: ModelDescriptor = {
      ...model("gpt-5.6-luna", "priced", false), ...officialOpenAiModelProfile("gpt-5.6-luna"),
    };
    const broker = new InMemoryCredentialBroker();
    broker.set("priced-credential", { authorizationHeader: "Bearer test-credential" });
    const adapter: ProviderAdapter = {
      providerId: "priced",
      async *stream() {
        yield {
          type: "usage", inputTokens: 200_000, outputTokens: 10_000,
          cachedInputTokens: 20_000, cacheWriteInputTokens: 10_000, imageInputTokens: 40_000,
        };
      },
    };
    const events = await collect(new RoutedModelGateway(
      new ModelRegistry([descriptor]).plan({ requiredCapabilities: ["text"] }), [adapter], broker,
    ).streamTurn({ messages: [{ role: "user", content: "priced" }], context: context(5) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "usage", costUsd: 0.2445 }));
  });
  it("BD-030-REGRESSION rejects unknown model prices under a route or run cost ceiling", async () => {
    const registry = new ModelRegistry([model("unknown-price", "unknown", false)]);
    expect(() => registry.plan({ requiredCapabilities: ["text"], maxInputUsdPerMillion: 10 }))
      .toThrow(expect.objectContaining({ code: "unknown_model_price" }));

    const broker = new InMemoryCredentialBroker();
    broker.set("unknown-credential", { authorizationHeader: "Bearer test-credential" });
    let providerCalls = 0;
    const adapter: ProviderAdapter = {
      providerId: "unknown",
      async *stream() {
        providerCalls += 1;
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const gateway = new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text"] }),
      [adapter],
      broker,
    );
    await expect(collect(gateway.streamTurn({
      messages: [{ role: "user", content: "hello" }],
      context: context(5),
    }))).rejects.toMatchObject({ code: "unknown_model_price" });
    expect(providerCalls).toBe(0);
  });

  it("prices omitted adapter cost from frozen model rates", async () => {
    const descriptor = model("priced-model", "priced", true);
    const registry = new ModelRegistry([descriptor]);
    const broker = new InMemoryCredentialBroker();
    broker.set("priced-credential", { authorizationHeader: "Bearer test-credential" });
    const adapter: ProviderAdapter = {
      providerId: "priced",
      async *stream() {
        yield { type: "usage", inputTokens: 500_000, outputTokens: 250_000 };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const gateway = new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text"] }),
      [adapter],
      broker,
    );
    const events = await collect(gateway.streamTurn({
      messages: [{ role: "user", content: "hello" }],
      context: context(5),
    }));
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 500_000,
      outputTokens: 250_000,
      costUsd: 2,
    });
  });

  it("uses the higher of provider-reported and locally calculated cost", async () => {
    const registry = new ModelRegistry([model("priced-model", "priced", true)]);
    const broker = new InMemoryCredentialBroker();
    broker.set("priced-credential", { authorizationHeader: "Bearer test-credential" });
    const adapter: ProviderAdapter = {
      providerId: "priced",
      async *stream() {
        yield { type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0.75 };
      },
    };
    const gateway = new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text"] }),
      [adapter],
      broker,
    );
    expect(await collect(gateway.streamTurn({
      messages: [{ role: "user", content: "hello" }],
      context: context(5),
    }))).toContainEqual({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0.75 });
  });

  it("never records omitted model-gateway cost as zero under a run ceiling", async () => {
    const unpriced: ModelGateway = {
      async *streamTurn() {
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    await expect(new AgentRunner(unpriced, new InMemoryToolRuntime()).run({
      input: "hello",
      workspaceId: "workspace_cost",
      runId: "run_cost",
      attemptId: "attempt_cost",
      fencingToken: 1,
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      maxCostUsd: 1,
      onEvent: () => undefined,
    })).rejects.toMatchObject({ code: "unknown_model_price" });
  });

  it("rejects unpriced Codex delegation before workspace or process access", async () => {
    let workspaceResolved = false;
    let processCreated = false;
    const gateway = new CodexAppServerGateway({
      workspacePathForRun: () => {
        workspaceResolved = true;
        return process.cwd();
      },
      processFactory: () => {
        processCreated = true;
        throw new Error("must not create process");
      },
    });
    await expect(collect(gateway.streamTurn({
      messages: [{ role: "user", content: "hello" }],
      context: context(1),
    }))).rejects.toMatchObject({ code: "unknown_model_price" });
    expect(workspaceResolved).toBe(false);
    expect(processCreated).toBe(false);
  });

  it("rejects partial or invalid model price records", () => {
    const partial = { ...model("partial", "provider", false), inputUsdPerMillion: 1 };
    expect(() => new ModelRegistry([partial])).toThrow(/both input and output/);
    expect(() => new ModelRegistry([{
      ...model("negative", "provider", true),
      outputUsdPerMillion: -1,
    }])).toThrow(/finite non-negative/);
  });
});
