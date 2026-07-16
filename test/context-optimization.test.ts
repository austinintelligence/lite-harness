import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConservativeContextCompiler, ContextStore } from "@lite-harness/context";
import { OpenAICompatibleProvider } from "@lite-harness/provider-openai-compatible";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable conservative optical context", () => {
  it("D21 BD-050-REGRESSION persists immutable exact canonical text when a vision route receives images", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-context-")); roots.push(root);
    const path = join(root, "context.sqlite");
    const exactText = `Reference header\n${"bounded semantic history line\n".repeat(80)}Recovery token: EXACT-RECOVERY-42`;
    const block = {
      id: "stable-block", kind: "memory" as const, exactText, lossyEligible: true, sensitive: false,
      provenance: "test:durable", timeRange: { start: "2026-07-14T00:00:00.000Z", end: "2026-07-14T01:00:00.000Z" },
    };
    const first = new ContextStore(path); first.put(block); first.close();
    const store = new ContextStore(path);
    expect(store.fetchExact(block.id)).toBe(exactText);
    expect(store.list()[0]).toMatchObject({ id: block.id, provenance: "test:durable", timeRange: block.timeRange });
    store.put(block);
    expect(() => store.put({ ...block, exactText: `${exactText} tampered` })).toThrow(/immutable/);

    const compiler = new ConservativeContextCompiler(
      store, { render: async () => ["data:image/png;base64,AAAA"] }, new Set(["vision-model"]),
    );
    expect((await compiler.compile("vision-model"))[0]).toMatchObject({ representation: "text", content: exactText });
    expect((await compiler.compile("unknown-model", "conservative", {
      appId: "app", tenantId: "tenant", modelCapabilities: ["text", "vision"],
    }))[0]).toMatchObject({ representation: "text", content: exactText });
    expect((await compiler.compile("vision-model", "conservative", {
      appId: "app", tenantId: "tenant", modelCapabilities: ["text"],
    }))[0]?.representation).toBe("text");
    const failedRender = new ConservativeContextCompiler(
      store, { render: async () => { throw new Error("renderer unavailable"); } }, new Set(["vision-model"]),
    );
    expect((await failedRender.compile("vision-model", "conservative", {
      appId: "app", tenantId: "tenant", modelCapabilities: ["text", "vision"],
    }))[0]).toMatchObject({ representation: "text", content: exactText });
    const rendered = await compiler.compile("vision-model", "conservative", {
      appId: "app", tenantId: "tenant", modelCapabilities: ["text", "vision"],
    });
    expect(rendered[0]).toMatchObject({
      id: block.id, representation: "image", content: ["data:image/png;base64,AAAA"],
      nativeLabel: expect.stringContaining("Exact canonical text is retained"), exactRecoveryAvailable: true,
    });

    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages).toEqual([{
        role: "user",
        content: [
          { type: "text", text: rendered[0]?.nativeLabel },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
        ],
      }]);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "EXACT-RECOVERY-42" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new OpenAICompatibleProvider({
      providerId: "openai-compatible", baseUrl: "https://provider.example/v1/",
      allowedOrigins: ["https://provider.example"], fetch,
    });
    const events = [];
    for await (const event of provider.stream({
      model: {
        id: "vision-model", providerId: "openai-compatible", transport: "direct", credentialProfileId: "test",
        capabilities: ["text", "vision"], contextWindow: 8_192, provenance: "static", enabled: true,
      },
      messages: [{ role: "user", content: rendered[0]?.nativeLabel ?? "", imageDataUrls: rendered[0]?.content as readonly string[] }],
      credential: { authorizationHeader: "Bearer placeholder" },
    })) events.push(event);
    expect(events).toContainEqual({ type: "usage", inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 });
    expect(store.fetchExact(block.id)).toBe(exactText);
    const sensitiveText = "Security policy remains native. ".repeat(50);
    const sourceText = "const immutableSource = true;\n".repeat(50);
    store.put({ id: "sensitive", kind: "memory", exactText: sensitiveText, lossyEligible: true, sensitive: true });
    store.put({ id: "source", kind: "source", exactText: sourceText, lossyEligible: true, sensitive: false });
    const guarded = await compiler.compile("vision-model", "conservative", {
      appId: "app", tenantId: "tenant", modelCapabilities: ["text", "vision"],
    });
    expect(guarded.find((item) => item.id === "sensitive")).toMatchObject({ representation: "text", content: sensitiveText });
    expect(guarded.find((item) => item.id === "source")).toMatchObject({ representation: "text", content: sourceText });
    store.close();
  });
});
