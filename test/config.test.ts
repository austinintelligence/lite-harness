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
    expect(manager).toMatchObject({ schemaVersion: 1, provider: "fake", runtime: "fake" });

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
