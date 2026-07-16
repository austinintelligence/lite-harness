import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { DEFAULT_RUN_BUDGET } from "@lite-harness/contracts";
import {
  InMemoryCredentialBroker, ModelRegistry, RoutedModelGateway,
  type ModelDescriptor, type ProviderAdapter, type RoutePersistenceHooks,
} from "@lite-harness/provider-core";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const stores: SqliteRunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("capability-derived durable model routing", () => {
  it("D29 D30 BD-039-REGRESSION selects a capability-policy route before compiling canonical context and persists actual usage", async () => {
    const store = new SqliteRunStore(":memory:");
    stores.push(store);
    const owner = { appId: "app", tenantId: "tenant", userId: "user" };
    const now = new Date().toISOString();
    store.createAgentProfile({
      id: "vision-agent", version: 1, ...owner, name: "Vision", instructions: "Inspect images",
      modelCapabilities: ["vision"], allowedTools: [], defaultBudget: { ...DEFAULT_RUN_BUDGET, maxCostUsd: 1 }, createdAt: now,
    });
    store.createWorkspace({ id: "workspace", ...owner, mode: "managed", state: "WARM", createdAt: now, updatedAt: now });
    const models: ModelDescriptor[] = [
      descriptor("text-model", "text-provider", ["text"]),
      descriptor("vision-model", "vision-provider", ["text", "vision"]),
    ];
    const registry = new ModelRegistry(models);
    const credentials = new InMemoryCredentialBroker();
    for (const model of models) credentials.set(model.credentialProfileId, { authorizationHeader: "Bearer local-test" });
    const called: string[] = [];
    const timeline: string[] = [];
    const adapters = models.map((model): ProviderAdapter => ({
      providerId: model.providerId,
      async *stream() {
        called.push(model.id);
        timeline.push(`stream:${model.id}`);
        yield { type: "request.accepted" };
        yield { type: "usage", inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, imageInputTokens: 4 };
        yield { type: "completed", finishReason: "stop" };
      },
    }));
    const hooks: RoutePersistenceHooks = {
      onRoutePlan: (context, plan, requiredCapabilities) => {
        timeline.push(`route:${plan.selected.providerId}:${plan.selected.id}:${plan.selected.credentialProfileId}:${plan.selected.transport}`);
        store.persistRunRoutePlan({
        runId: context.runId, attemptId: context.attemptId, routePlanId: plan.id,
        registryGeneration: plan.registryGeneration, requiredCapabilities: [...requiredCapabilities],
        selectedModelId: plan.selected.id, selectedProviderId: plan.selected.providerId,
        selectedCredentialProfileId: plan.selected.credentialProfileId,
        fallbackModelIds: plan.fallbacks.map((model) => model.id), createdAt: plan.createdAt,
        });
      },
      onUsage: (context, plan, model, usage) => { store.persistRunModelUsage({
        runId: context.runId, attemptId: context.attemptId, routePlanId: plan.id,
        modelId: model.id, providerId: model.providerId, inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
        ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
        ...(usage.imageInputTokens === undefined ? {} : { imageInputTokens: usage.imageInputTokens }),
        priceSnapshot: {
          currency: "USD", source: "test", inputUsdPerMillion: 0,
          outputUsdPerMillion: 0, imageInputUsdPerMillion: 0,
        },
        recordedAt: new Date().toISOString(),
      }); },
    };
    const compiledFor: Array<string | undefined> = [];
    const service = new RunService(store, new AgentRunner(
      new RoutedModelGateway(registry, adapters, credentials, hooks), new InMemoryToolRuntime(), 8,
      { compile: async (params) => { compiledFor.push(params.modelId); timeline.push(`compile:${params.modelId}`); return []; } },
    ));
    const created = service.createRun({
      agent: "vision-agent", workspace: "workspace", input: "inspect", idempotencyKey: "route-once",
      principal: { ...owner, scopes: ["runs:create"] },
    });
    await expect(service.waitForTerminal(created.runId)).resolves.toMatchObject({ status: "SUCCEEDED" });
    const attempt = store.listRunAttempts(created.runId)[0];
    expect(called).toEqual(["vision-model"]);
    expect(compiledFor).toEqual(["vision-model"]);
    expect(timeline).toEqual([
      "route:vision-provider:vision-model:vision-provider-credential:direct",
      "compile:vision-model",
      "stream:vision-model",
    ]);
    expect(store.getRunRoutePlan(created.runId, attempt!.id)).toMatchObject({
      requiredCapabilities: ["text", "vision"], selectedModelId: "vision-model",
      selectedProviderId: "vision-provider", selectedCredentialProfileId: "vision-provider-credential",
      fallbackModelIds: [],
    });
    expect(store.listRunModelUsage(created.runId)).toMatchObject([{
      routePlanId: expect.stringMatching(/^route_/), modelId: "vision-model", providerId: "vision-provider",
      inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, imageInputTokens: 4, costUsd: 0,
      priceSnapshot: { currency: "USD", source: "test", imageInputUsdPerMillion: 0 },
    }]);
    await service.shutdown();
  });
});

function descriptor(id: string, providerId: string, capabilities: ModelDescriptor["capabilities"]): ModelDescriptor {
  return {
    id, providerId, transport: "direct", credentialProfileId: `${providerId}-credential`, capabilities,
    contextWindow: 128_000, inputUsdPerMillion: 0, outputUsdPerMillion: 0, provenance: "operator", enabled: true,
  };
}
