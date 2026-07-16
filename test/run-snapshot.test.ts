import { describe, expect, it } from "vitest";
import { AgentRunner } from "@lite-harness/agent-runtime";
import { RunService } from "@lite-harness/control-plane";
import { DEFAULT_RUN_BUDGET } from "@lite-harness/contracts";
import {
  InMemoryCredentialBroker, ModelRegistry, RoutedModelGateway,
  type ModelDescriptor, type ProviderAdapter, type RoutePersistenceHooks,
} from "@lite-harness/provider-core";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

describe("immutable durable RunSnapshot", () => {
  it("BD-048-REGRESSION freezes every execution input before the first model turn", async () => {
    const store = new SqliteRunStore(":memory:");
    const owner = { appId: "app", tenantId: "tenant", userId: "user" }; const now = new Date().toISOString();
    store.createAgentProfile({
      id: "coder", version: 7, ...owner, name: "Coder", instructions: "Pinned instructions",
      modelCapabilities: ["text", "tools"], allowedTools: ["read_file"], defaultBudget: DEFAULT_RUN_BUDGET, createdAt: now,
    });
    store.createWorkspace({ id: "workspace", ...owner, mode: "managed", state: "WARM", createdAt: now, updatedAt: now });
    const model: ModelDescriptor = {
      id: "model", providerId: "provider", transport: "direct", credentialProfileId: "provider-profile",
      capabilities: ["text", "tools"], contextWindow: 128_000, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
      provenance: "operator", enabled: true,
    };
    const credentials = new InMemoryCredentialBroker(); credentials.set(model.credentialProfileId, { authorizationHeader: "Bearer local-test" });
    let activeRunId = ""; let activeAttemptId = "";
    const adapter: ProviderAdapter = {
      providerId: "provider",
      async *stream() {
        expect(store.getRunSnapshot(activeRunId, activeAttemptId)).toBeDefined();
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const hooks: RoutePersistenceHooks = { onRoutePlan: (context, plan, capabilities) => {
      activeRunId = context.runId; activeAttemptId = context.attemptId;
      store.persistRunRoutePlan({
        runId: context.runId, attemptId: context.attemptId, routePlanId: plan.id, registryGeneration: plan.registryGeneration,
        requiredCapabilities: [...capabilities], selectedModelId: plan.selected.id, selectedProviderId: plan.selected.providerId,
        selectedCredentialProfileId: plan.selected.credentialProfileId, fallbackModelIds: [], createdAt: plan.createdAt,
      });
    } };
    const context = {
      compile: async () => [],
      snapshotForRun: async () => ({ skills: [{ name: "review", digest: "a".repeat(64) }] }),
    };
    let releaseStarted!: () => void;
    let allowRelease!: () => void;
    let releaseMode: "gated" | "debt" | "throw" = "gated";
    const releaseStartedPromise = new Promise<void>((resolveRelease) => { releaseStarted = resolveRelease; });
    const releaseGate = new Promise<void>((resolveRelease) => { allowRelease = resolveRelease; });
    const service = new RunService(store, new AgentRunner(
      new RoutedModelGateway(new ModelRegistry([model]), [adapter], credentials, hooks), new InMemoryToolRuntime(), 8, context,
    ), {
      runSnapshot: {
        runtimeProfile: { id: "docker", imageDigest: `sha256:${"b".repeat(64)}`, policyDigest: "c".repeat(64) },
        networkPolicy: { id: "network-none-v1", digest: "d".repeat(64) },
        plugins: [{ id: "openclaw-compat", version: "1.0.0", digest: "e".repeat(64) }],
        credentialProfileIds: ["snapshot.root"],
        releaseRun: async () => {
          if (releaseMode === "debt") return { outcome: "cleanup-debt-recorded" } as const;
          if (releaseMode === "throw") throw new Error("injected finalization failure");
          releaseStarted();
          await releaseGate;
          return { outcome: "released" } as const;
        },
      },
    });
    try {
      const created = service.createRun({ agent: "coder", workspace: "workspace", input: "run", idempotencyKey: "snapshot", principal: { ...owner, scopes: ["runs:create"] } });
      await releaseStartedPromise;
      expect(service.getRun(created.runId)?.status).not.toMatch(/^(SUCCEEDED|FAILED|CANCELLED|TIMED_OUT|ORPHANED)$/);
      expect(service.listEvents(created.runId).some((event) => event.type === "run.succeeded")).toBe(false);
      allowRelease();
      expect((await service.waitForTerminal(created.runId)).status).toBe("SUCCEEDED");
      const attempt = store.listRunAttempts(created.runId)[0]!; const snapshot = store.getRunSnapshot(created.runId, attempt.id)!;
      expect(snapshot).toMatchObject({
        schemaVersion: 1, agent: { id: "coder", version: 7, instructions: "Pinned instructions" },
        tools: [{ name: "read_file" }], skills: [{ name: "review", digest: "a".repeat(64) }],
        plugins: [{ id: "openclaw-compat", version: "1.0.0" }], providerRoute: { selectedModelId: "model" },
        runtimeProfile: { id: "docker" }, networkPolicy: { id: "network-none-v1" },
        credentialProfileIds: ["provider-profile", "snapshot.root"], digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() => store.persistRunSnapshot({ ...snapshot, networkPolicy: { id: "changed", digest: "f".repeat(64) } })).toThrow(/already frozen/);
      expect(service.listEvents(created.runId).map((event) => event.type)).toContain("run.snapshot.frozen");
      releaseMode = "debt";
      const cleanupFailure = service.createRun({
        agent: "coder", workspace: "workspace", input: "cleanup-failure", idempotencyKey: "snapshot-cleanup-failure",
        principal: { ...owner, scopes: ["runs:create"] },
      });
      expect((await service.waitForTerminal(cleanupFailure.runId)).status).toBe("ORPHANED");
      expect(service.listEvents(cleanupFailure.runId).findLast((event) => event.type === "run.orphaned")?.payload).toMatchObject({
        code: "run_cleanup_failed", retryable: true,
      });
      releaseMode = "throw";
      const finalizationFailure = service.createRun({
        agent: "coder", workspace: "workspace", input: "finalization-failure", idempotencyKey: "snapshot-finalization-failure",
        principal: { ...owner, scopes: ["runs:create"] },
      });
      expect((await service.waitForTerminal(finalizationFailure.runId)).status).toBe("ORPHANED");
      expect(service.listEvents(finalizationFailure.runId).findLast((event) => event.type === "run.orphaned")?.payload).toMatchObject({
        code: "run_finalization_failed", retryable: true,
      });
    } finally { await service.shutdown(); store.close(); }
  });
});
