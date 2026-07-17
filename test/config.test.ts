import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRoleEnvironment,
  loadGatewayConfiguration,
  loadInstallationConfiguration,
  loadManagerConfiguration,
  loadManagerIpcConfiguration,
  readInstallationConfiguration,
  writeInstallationConfiguration,
} from "@lite-harness/config";

const tokens = {
  LITE_HARNESS_INTERNAL_TOKEN: "internal-token-for-tests",
  LITE_HARNESS_APP_TOKEN: "application-token-for-tests",
};

describe("versioned application configuration", () => {
  it("persists validated non-secret installation settings and builds isolated role environments", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-installation-"));
    try {
      const installation = loadInstallationConfiguration({
        ...tokens,
        LITE_HARNESS_PROVIDER: "fake",
        LITE_HARNESS_RUNTIME: "fake",
        LITE_HARNESS_MODE: "development",
        LITE_HARNESS_PROVIDER_API_KEY: "must-not-be-persisted",
        LITE_HARNESS_PROVIDER_BASE_URL: "http://127.0.0.1:8645/v1",
        LITE_HARNESS_MODEL: "fixture-model",
        LITE_HARNESS_PORT: "4321",
        LITE_HARNESS_ENABLE_MEMORY: "true",
        LITE_HARNESS_WEBHOOK_SECRET: "must-not-be-persisted-either",
      }, root, "win32");
      const path = writeInstallationConfiguration(installation);
      const persisted = readFileSync(path, "utf8");
      expect(persisted).toContain("fixture-model");
      expect(persisted).not.toContain("must-not-be-persisted");

      const restored = readInstallationConfiguration(installation.dataDir, "win32");
      const overrides = { LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_INTERNAL_TOKEN: tokens.LITE_HARNESS_INTERNAL_TOKEN, PATH: "fixture-path" };
      const manager = buildRoleEnvironment("manager", restored, overrides, overrides);
      const gateway = buildRoleEnvironment("gateway", restored, {
        ...overrides, LITE_HARNESS_APP_TOKEN: tokens.LITE_HARNESS_APP_TOKEN,
        LITE_HARNESS_PORT: "5432",
      }, {
        ...overrides, LITE_HARNESS_APP_TOKEN: tokens.LITE_HARNESS_APP_TOKEN,
      });
      expect(manager).toMatchObject({ LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_INTERNAL_TOKEN: tokens.LITE_HARNESS_INTERNAL_TOKEN, PATH: "fixture-path" });
      expect(manager).not.toHaveProperty("LITE_HARNESS_APP_TOKEN");
      expect(manager).not.toHaveProperty("LITE_HARNESS_WEBHOOK_SECRET");
      expect(gateway).toMatchObject({ LITE_HARNESS_PORT: "5432", LITE_HARNESS_APP_TOKEN: tokens.LITE_HARNESS_APP_TOKEN });
      expect(gateway).toHaveProperty("LITE_HARNESS_INTERNAL_TOKEN", tokens.LITE_HARNESS_INTERNAL_TOKEN);
      expect(gateway).not.toHaveProperty("LITE_HARNESS_PROVIDER");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads local Manager IPC coordinates without requiring provider, runtime, or application credentials", () => {
    const first = loadManagerIpcConfiguration({ LITE_HARNESS_DATA_DIR: "C:/fixture/state" }, "C:/fixture", "win32");
    const second = loadManagerIpcConfiguration({ LITE_HARNESS_DATA_DIR: "C:/fixture/other" }, "C:/fixture", "win32");
    expect(first).toMatchObject({
      schemaVersion: 1,
      dataDir: "C:\\fixture\\state",
      socketPath: expect.stringMatching(/^\\\\\.\\pipe\\lite-harness-manager-[a-f0-9]{16}$/),
    });
    expect(second.socketPath).not.toBe(first.socketPath);
  });

  it("materializes explicit development defaults only for first-run service installation", () => {
    const installation = loadInstallationConfiguration({ LITE_HARNESS_DATA_DIR: "C:/fixture/state" }, "C:/fixture", "win32", { developmentDefaults: true });
    expect(installation.environment).toMatchObject({ LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake", LITE_HARNESS_MODE: "development" });
    expect(() => loadInstallationConfiguration({ LITE_HARNESS_DATA_DIR: "C:/fixture/state" }, "C:/fixture", "win32")).toThrow(/LITE_HARNESS_PROVIDER/);
  });

  it("parses bounded core Manager and Gateway configuration", () => {
    const manager = loadManagerConfiguration({
      ...tokens,
      LITE_HARNESS_CONFIG_VERSION: "1",
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_MODE: "development",
    }, "C:/fixture", "win32");
    expect(manager).toMatchObject({
      schemaVersion: 1, provider: "fake", runtime: "fake",
      offline: false,
      approvalTimeoutMs: 60_000, shutdownTimeoutMs: 30_000,
      workspaceQuotaBytes: 1024 * 1024 * 1024, browserIdleMs: 60_000,
      runtimeMemory: "512m", runtimeCpus: "1", runtimePids: 128,
      memoryEnabled: false, approvalsRequired: false, workspaceColdAfterCheckpoint: false,
      browserPrivateNetworksAllowed: false, contextOptimizationEnabled: false,
      pluginsEnabled: false, cacheCatalogEnabled: false,
    });

    const gateway = loadGatewayConfiguration({
      ...tokens,
      LITE_HARNESS_PORT: "4321",
      LITE_HARNESS_AUTH_FAILURE_LIMIT: "5",
      LITE_HARNESS_AUTH_FAILURE_WINDOW_MS: "30000",
    }, "C:/fixture", "win32");
    expect(gateway).toMatchObject({
      schemaVersion: 1, host: "127.0.0.1", port: 4321, authFailureLimit: 5, authFailureWindowMs: 30_000,
    });
  });

  it.each([
    [{ ...tokens, LITE_HARNESS_PORT: "NaN" }, /integer/],
    [{ ...tokens, LITE_HARNESS_PORT: "65536" }, /between/],
    [{ ...tokens, LITE_HARNESS_HOST: "0.0.0.0" }, /loopback-only/],
    [{ ...tokens, LITE_HARNESS_CONFIG_VERSION: "2" }, /Unsupported/],
    [{ ...tokens, LITE_HARNESS_AUTH_FAILURE_LIMIT: "0" }, /between/],
    [{ ...tokens, LITE_HARNESS_AUTH_FAILURE_WINDOW_MS: "999" }, /between/],
  ])("rejects unsafe Gateway configuration %#", (environment, expected) => {
    expect(() => loadGatewayConfiguration(environment, "C:/fixture", "win32")).toThrow(expected);
  });

  it.each([
    [{ ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake", LITE_HARNESS_MODE: "development", LITE_HARNESS_APPROVAL_TIMEOUT_MS: "NaN" }, /APPROVAL_TIMEOUT_MS.*integer/],
    [{ ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake", LITE_HARNESS_MODE: "development", LITE_HARNESS_DELEGATED_MAX_BUDGET_USD: "Infinity" }, /DELEGATED_MAX_BUDGET_USD.*finite/],
    [{ ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake", LITE_HARNESS_MODE: "development", LITE_HARNESS_RUNTIME_CPUS: "NaN" }, /RUNTIME_CPUS.*finite/],
    [{ ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake", LITE_HARNESS_MODE: "development", LITE_HARNESS_RUNTIME_MEMORY: "1t" }, /RUNTIME_MEMORY.*bounded/],
    [{ ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake", LITE_HARNESS_MODE: "development", LITE_HARNESS_RUNTIME_PIDS: "0" }, /RUNTIME_PIDS.*between/],
    [{ ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake", LITE_HARNESS_MODE: "development", LITE_HARNESS_MODEL_CONTEXT: "0" }, /MODEL_CONTEXT.*between/],
  ])("rejects unsafe Manager configuration %#", (environment, expected) => {
    expect(() => loadManagerConfiguration(environment, "C:/fixture", "win32")).toThrow(expected);
  });

  it.each([
    "LITE_HARNESS_ENABLE_MEMORY",
    "LITE_HARNESS_REQUIRE_APPROVALS",
    "LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT",
    "LITE_HARNESS_BROWSER_ALLOW_PRIVATE",
    "LITE_HARNESS_CONTEXT_OPTIMIZATION",
    "LITE_HARNESS_ENABLE_PLUGINS",
    "LITE_HARNESS_ENABLE_CACHE_CATALOG",
    "LITE_HARNESS_OFFLINE",
  ])("rejects misspelled Manager boolean %s instead of silently disabling it", (name) => {
    expect(() => loadManagerConfiguration({
      ...tokens,
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_MODE: "development",
      [name]: "tru",
    }, "C:/fixture", "win32")).toThrow(new RegExp(`${name}.*exactly true or false`));
  });

  it("parses bounded Manager operational numbers only once at the configuration boundary", () => {
    const manager = loadManagerConfiguration({
      ...tokens,
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_MODE: "development",
      LITE_HARNESS_APPROVAL_TIMEOUT_MS: "120000",
      LITE_HARNESS_SHUTDOWN_TIMEOUT_MS: "45000",
      LITE_HARNESS_WORKSPACE_QUOTA_BYTES: "16777216",
      LITE_HARNESS_BROWSER_IDLE_MS: "90000",
      LITE_HARNESS_MODEL_CONTEXT: "131072",
      LITE_HARNESS_DELEGATED_MAX_BUDGET_USD: "1.25",
      LITE_HARNESS_RUNTIME_MEMORY: "1g",
      LITE_HARNESS_RUNTIME_CPUS: "2.5",
      LITE_HARNESS_RUNTIME_PIDS: "256",
      LITE_HARNESS_ENABLE_MEMORY: "true",
      LITE_HARNESS_REQUIRE_APPROVALS: "true",
      LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT: "true",
      LITE_HARNESS_BROWSER_ALLOW_PRIVATE: "true",
      LITE_HARNESS_CONTEXT_OPTIMIZATION: "true",
      LITE_HARNESS_ENABLE_PLUGINS: "true",
      LITE_HARNESS_ENABLE_CACHE_CATALOG: "true",
    }, "C:/fixture", "win32");
    expect(manager).toMatchObject({
      approvalTimeoutMs: 120_000, shutdownTimeoutMs: 45_000, workspaceQuotaBytes: 16 * 1024 * 1024,
      browserIdleMs: 90_000, modelContext: 131_072, delegatedMaxBudgetUsd: 1.25,
      runtimeMemory: "1g", runtimeCpus: "2.5", runtimePids: 256,
      memoryEnabled: true, approvalsRequired: true, workspaceColdAfterCheckpoint: true,
      browserPrivateNetworksAllowed: true, contextOptimizationEnabled: true,
      pluginsEnabled: true, cacheCatalogEnabled: true,
    });
  });

  it("requires explicit provider and runtime selection", () => {
    expect(() => loadManagerConfiguration(tokens, "C:/fixture", "win32")).toThrow(/LITE_HARNESS_PROVIDER/);
  });

  it("fails closed when production selects a fake provider or runtime", () => {
    expect(() => loadManagerConfiguration({
      ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "docker",
    }, "C:/fixture", "win32")).toThrow(/Production mode forbids fake/);
    expect(() => loadManagerConfiguration({
      ...tokens, LITE_HARNESS_PROVIDER: "openai-compatible", LITE_HARNESS_RUNTIME: "fake",
    }, "C:/fixture", "win32")).toThrow(/Production mode forbids fake/);
  });

  it("A22-OFFLINE-CONFIG-FAIL-CLOSED permits only fake or loopback model routes and rejects outbound packs", () => {
    const offlineDevelopment = {
      ...tokens, LITE_HARNESS_PROVIDER: "fake", LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_MODE: "development", LITE_HARNESS_OFFLINE: "true",
    };
    expect(loadManagerConfiguration(offlineDevelopment, "C:/fixture", "win32")).toMatchObject({ offline: true, provider: "fake" });
    expect(loadManagerConfiguration({
      ...tokens, LITE_HARNESS_PROVIDER: "openai-compatible", LITE_HARNESS_PROVIDER_BASE_URL: "http://127.0.0.1:8645/v1",
      LITE_HARNESS_RUNTIME: "docker", LITE_HARNESS_OFFLINE: "true",
    }, "C:/fixture", "win32")).toMatchObject({ offline: true, provider: "openai-compatible" });
    expect(() => loadManagerConfiguration({
      ...offlineDevelopment, LITE_HARNESS_PROVIDER: "openai-compatible", LITE_HARNESS_PROVIDER_BASE_URL: "https://provider.example/v1",
    }, "C:/fixture", "win32")).toThrow(/loopback/);
    for (const baseUrl of ["http://127.0.0.2:8645/v1", "http://agent.localhost:8645/v1"]) {
      expect(() => loadManagerConfiguration({
        ...offlineDevelopment, LITE_HARNESS_PROVIDER: "openai-compatible", LITE_HARNESS_PROVIDER_BASE_URL: baseUrl,
      }, "C:/fixture", "win32")).toThrow(/loopback/);
    }
    expect(() => loadManagerConfiguration({
      ...offlineDevelopment, LITE_HARNESS_BROWSER_IMAGE: `sha256:${"a".repeat(64)}`,
    }, "C:/fixture", "win32")).toThrow(/Offline mode forbids.*BROWSER_IMAGE/);
    expect(() => loadManagerConfiguration({
      ...offlineDevelopment, LITE_HARNESS_APP_CALLBACK_URL: "http://127.0.0.1/callback",
    }, "C:/fixture", "win32")).toThrow(/Offline mode forbids.*APP_CALLBACK_URL/);
  });
});
