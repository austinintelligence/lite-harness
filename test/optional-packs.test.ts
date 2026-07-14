import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTriggerStore, SchedulerEngine, nextDailyOccurrence } from "@lite-harness/automation";
import { assertBrowserUrlAllowed, BrowserSessionBroker } from "@lite-harness/browser";
import { DeliveryDedupe, normalizeInbound, verifyHmacSha256 } from "@lite-harness/integrations";
import { SqliteMemoryStore } from "@lite-harness/memory-sqlite";
import { SubagentGraph } from "@lite-harness/subagents";

describe("optional capability packs", () => {
  it("denies browser private networks and isolates session ownership", async () => {
    await expect(
      assertBrowserUrlAllowed("http://metadata.example/latest", {}, async () => ["169.254.169.254"]),
    ).rejects.toThrow(/private or metadata/);
    await expect(
      assertBrowserUrlAllowed("https://public.example", {}, async () => ["93.184.216.34"]),
    ).resolves.toMatchObject({ origin: "https://public.example" });

    const broker = new BrowserSessionBroker();
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run" };
    const session = broker.create(owner);
    expect(() => broker.attachTab(session, { ...owner, tenantId: "other" }, "tab-1")).toThrow(/does not belong/);
    broker.attachTab(session, owner, "tab-1");
    broker.close(session, owner);
    expect(broker.activeCount).toBe(0);
  });

  it("verifies webhook signatures and deduplicates deliveries by connector account", () => {
    const body = Buffer.from("payload");
    const secret = Buffer.from("connector-secret");
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyHmacSha256(body, signature, secret)).toBe(true);
    const envelope = normalizeInbound({
      connectorId: "webhook",
      accountId: "account-1",
      deliveryId: "delivery-1",
      senderExternalId: "sender-1",
      text: "hello",
    });
    const dedupe = new DeliveryDedupe();
    expect(dedupe.claim(envelope)).toBe(true);
    expect(dedupe.claim(envelope)).toBe(false);
  });

  it("uses trigger leases so two schedulers cannot fire the same occurrence", async () => {
    const store = new InMemoryTriggerStore();
    store.put({ id: "every-minute", intervalMs: 60_000, nextFireAt: 1_000, payload: {} });
    const createRun = vi.fn(async () => undefined);
    const first = new SchedulerEngine(store, "scheduler-a", createRun);
    const second = new SchedulerEngine(store, "scheduler-b", createRun);
    expect(await Promise.all([first.tick(1_000), second.tick(1_000)])).toEqual([1, 0]);
    expect(createRun).toHaveBeenCalledOnce();
  });

  it("supports explicit missed-run catch-up and daylight-aware local schedules", async () => {
    const store = new InMemoryTriggerStore();
    store.put({ id: "catch-up", intervalMs: 1_000, nextFireAt: 1_000, payload: {}, missedRunPolicy: "catch-up" });
    const createRun = vi.fn(async () => undefined);
    const scheduler = new SchedulerEngine(store, "scheduler", createRun);
    expect(await scheduler.tick(5_000)).toBe(1);
    expect(await scheduler.tick(5_000)).toBe(1);
    expect(createRun).toHaveBeenCalledTimes(2);
    const next = nextDailyOccurrence("America/Chicago", "09:30", Date.parse("2026-03-08T13:00:00Z"));
    expect(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(next)).toBe("09:30");
    const afterMissingTime = nextDailyOccurrence("America/Chicago", "02:30", Date.parse("2026-03-08T06:00:00Z"));
    expect(new Date(afterMissingTime).toISOString()).toBe("2026-03-09T07:30:00.000Z");
  });

  it("propagates parent cancellation and enforces child budgets and depth", () => {
    const graph = new SubagentGraph(2);
    graph.addRoot("run-root", { maxTokens: 10_000, maxCostUsd: 5 });
    expect(() => graph.createChild("run-root", { maxTokens: 20_000, maxCostUsd: 1 })).toThrow(/budget/);
    const child = graph.createChild("run-root", { maxTokens: 2_000, maxCostUsd: 1 });
    const grandchild = graph.createChild(child.runId, { maxTokens: 500, maxCostUsd: 0.25 });
    expect(() => graph.createChild(grandchild.runId, { maxTokens: 100, maxCostUsd: 0.1 })).toThrow(/nesting/);
    expect(graph.cancel("run-root")).toEqual([grandchild.runId, child.runId, "run-root"]);
  });

  it("keeps exact memory offline and tenant/workspace scoped", () => {
    const store = new SqliteMemoryStore(":memory:");
    try {
      store.add("tenant-a", "workspace-a", "The deployment uses a blue canary.");
      store.add("tenant-b", "workspace-a", "The deployment uses a red canary.");
      expect(store.search("tenant-a", "workspace-a", "blue canary")).toMatchObject([
        { tenantId: "tenant-a", markdown: "The deployment uses a blue canary." },
      ]);
      expect(store.search("tenant-a", "workspace-a", "red")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
