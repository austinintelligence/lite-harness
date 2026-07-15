import { describe, expect, it } from "vitest";
import {
  InMemoryCredentialBroker,
  ModelRegistry,
  ProviderError,
  RoutedModelGateway,
  SingleFlightCredentialBroker,
  redactProviderData,
  type ModelCapability,
  type ModelDescriptor,
  type ProviderAdapter,
} from "@lite-harness/provider-core";

const baseModel = (
  id: string,
  providerId: string,
  capabilities: readonly ModelCapability[] = ["text"],
): ModelDescriptor => ({
  id,
  providerId,
  transport: "direct",
  credentialProfileId: `${providerId}-credential`,
  capabilities,
  contextWindow: 128_000,
  inputUsdPerMillion: providerId === "preferred" ? 1 : 2,
  outputUsdPerMillion: 4,
  provenance: "static",
  enabled: true,
});

describe("provider plane", () => {
  it("rejects models missing a required capability before execution", () => {
    const registry = new ModelRegistry([baseModel("text-only", "preferred")]);
    expect(() => registry.plan({ requiredCapabilities: ["text", "tools"] })).toThrow(
      /No enabled model/,
    );
  });

  it("falls back on retryable pre-side-effect failure", async () => {
    const registry = new ModelRegistry([
      baseModel("first", "preferred"),
      baseModel("second", "fallback"),
    ]);
    const broker = new InMemoryCredentialBroker();
    broker.set("preferred-credential", { authorizationHeader: "Bearer preferred-secret" });
    broker.set("fallback-credential", { authorizationHeader: "Bearer fallback-secret" });
    const failing: ProviderAdapter = {
      providerId: "preferred",
      async *stream() {
        throw new ProviderError("rate_limited", "retry", true, 429);
      },
    };
    const fallback: ProviderAdapter = {
      providerId: "fallback",
      async *stream() {
        yield { type: "text.delta", delta: "fallback worked" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const gateway = new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text"] }),
      [failing, fallback],
      broker,
    );
    const events = [];
    for await (const event of gateway.streamTurn({ messages: [{ role: "user", content: "hello" }] })) {
      events.push(event);
    }
    expect(events).toContainEqual({ type: "text.delta", delta: "fallback worked" });
  });

  it("fails closed instead of sending model-specific optical context to a fallback", async () => {
    const registry = new ModelRegistry([
      baseModel("first", "preferred", ["text", "vision"]),
      baseModel("second", "fallback", ["text", "vision"]),
    ]);
    const broker = new InMemoryCredentialBroker();
    broker.set("preferred-credential", { authorizationHeader: "Bearer preferred-secret" });
    broker.set("fallback-credential", { authorizationHeader: "Bearer fallback-secret" });
    let fallbackCalls = 0;
    const gateway = new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text", "vision"] }),
      [{ providerId: "preferred", async *stream() { throw new ProviderError("rate_limited", "retry", true, 429); } }, {
        providerId: "fallback", async *stream() { fallbackCalls += 1; yield { type: "completed", finishReason: "stop" }; },
      }],
      broker,
    );
    await expect(async () => {
      for await (const _event of gateway.streamTurn({
        messages: [{ role: "user", content: "optical", imageDataUrls: ["data:image/png;base64,AAAA"] }],
      })) { /* consume */ }
    }).rejects.toMatchObject({ code: "context_recompile_required" });
    expect(fallbackCalls).toBe(0);
  });

  it("does not fallback after a tool call has become externally visible", async () => {
    const registry = new ModelRegistry([
      baseModel("first", "preferred", ["text", "tools"]),
      baseModel("second", "fallback", ["text", "tools"]),
    ]);
    const broker = new InMemoryCredentialBroker();
    broker.set("preferred-credential", { authorizationHeader: "Bearer preferred-secret" });
    broker.set("fallback-credential", { authorizationHeader: "Bearer fallback-secret" });
    let fallbackCalls = 0;
    const first: ProviderAdapter = {
      providerId: "preferred",
      async *stream() {
        yield { type: "tool.call", call: { id: "call-1", name: "write_file", arguments: {} } };
        throw new ProviderError("provider_unavailable", "failed after tool", true, 503);
      },
    };
    const second: ProviderAdapter = {
      providerId: "fallback",
      async *stream() {
        fallbackCalls += 1;
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const gateway = new RoutedModelGateway(
      registry.plan({ requiredCapabilities: ["text", "tools"] }),
      [first, second],
      broker,
    );
    await expect(async () => {
      for await (const _event of gateway.streamTurn({ messages: [{ role: "user", content: "hello" }] })) {
        // consume
      }
    }).rejects.toThrow(/failed after tool/);
    expect(fallbackCalls).toBe(0);
  });

  it("BD-031-REGRESSION never falls back after request acceptance or usage visibility", async () => {
    for (const firstVisibleEvent of [
      { type: "request.accepted" as const },
      { type: "usage" as const, inputTokens: 1, outputTokens: 1 },
    ]) {
      const registry = new ModelRegistry([
        baseModel("first", "preferred"),
        baseModel("second", "fallback"),
      ]);
      const broker = new InMemoryCredentialBroker();
      broker.set("preferred-credential", { authorizationHeader: "Bearer preferred-secret" });
      broker.set("fallback-credential", { authorizationHeader: "Bearer fallback-secret" });
      let fallbackCalls = 0;
      const first: ProviderAdapter = {
        providerId: "preferred",
        async *stream() {
          yield firstVisibleEvent;
          throw new ProviderError("provider_unavailable", "failed after provider visibility", true, 503);
        },
      };
      const fallback: ProviderAdapter = {
        providerId: "fallback",
        async *stream() {
          fallbackCalls += 1;
          yield { type: "completed", finishReason: "stop" };
        },
      };
      const gateway = new RoutedModelGateway(
        registry.plan({ requiredCapabilities: ["text"] }),
        [first, fallback],
        broker,
      );
      await expect(async () => {
        for await (const _event of gateway.streamTurn({ messages: [{ role: "user", content: "hello" }] })) {
          // consume until the post-visibility failure
        }
      }).rejects.toThrow(/failed after provider visibility/);
      expect(fallbackCalls).toBe(0);
    }
  });

  it("redacts credential fields and embedded provider keys recursively", () => {
    const keyShapedFixture = ["sk", "abcdefghijklmnopqrstuvwxyz1234567890"].join("-");
    expect(
      redactProviderData({ authorization: "Bearer abcdefghijklmnop", nested: [keyShapedFixture] }),
    ).toEqual({ authorization: "[REDACTED]", nested: ["[REDACTED]"] });
  });

  it("refreshes an expiring credential exactly once for concurrent callers", async () => {
    let refreshes = 0;
    const broker = new SingleFlightCredentialBroker({
      async load() { return { authorizationHeader: "Bearer stale", expiresAt: new Date(Date.now() + 1_000).toISOString() }; },
      async refresh() {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { authorizationHeader: "Bearer fresh", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
      },
    });
    const credentials = await Promise.all([broker.resolve("profile"), broker.resolve("profile"), broker.resolve("profile")]);
    expect(credentials.map((item) => item.authorizationHeader)).toEqual(["Bearer fresh", "Bearer fresh", "Bearer fresh"]);
    expect(refreshes).toBe(1);
  });
});
