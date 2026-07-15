import { describe, expect, it } from "vitest";
import { loadGatewayConfiguration, loadManagerConfiguration } from "@lite-harness/config";

const tokens = {
  LITE_HARNESS_INTERNAL_TOKEN: "internal-token-for-tests",
  LITE_HARNESS_APP_TOKEN: "application-token-for-tests",
};

describe("versioned application configuration", () => {
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
      approvalTimeoutMs: 60_000, shutdownTimeoutMs: 30_000,
      workspaceQuotaBytes: 1024 * 1024 * 1024, browserIdleMs: 60_000,
      runtimeMemory: "512m", runtimeCpus: "1", runtimePids: 128,
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
    }, "C:/fixture", "win32");
    expect(manager).toMatchObject({
      approvalTimeoutMs: 120_000, shutdownTimeoutMs: 45_000, workspaceQuotaBytes: 16 * 1024 * 1024,
      browserIdleMs: 90_000, modelContext: 131_072, delegatedMaxBudgetUsd: 1.25,
      runtimeMemory: "1g", runtimeCpus: "2.5", runtimePids: 256,
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
});
