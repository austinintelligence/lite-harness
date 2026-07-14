import { describe, expect, it } from "vitest";
import { LiteHarnessClient, LiteHarnessError } from "@lite-harness/sdk";

describe("versioned SDK error contract", () => {
  it("preserves stable error fields from the REST envelope", async () => {
    const client = new LiteHarnessClient({
      baseUrl: "http://127.0.0.1:3210",
      token: "test-token",
      fetch: async () => new Response(JSON.stringify({
        error: {
          version: 1,
          code: "rate_limited",
          message: "Try later",
          retryable: true,
          retryAfterMs: 250,
          details: { provider: "fixture" },
        },
      }), { status: 429, headers: { "content-type": "application/json" } }),
    });

    const error = await client.getRun("run_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LiteHarnessError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 250,
      details: { provider: "fixture" },
    });
  });
});
