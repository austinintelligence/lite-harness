import { describe, expect, it } from "vitest";
import { InMemoryTriggerStore, SchedulerEngine, SqliteTriggerStore } from "@lite-harness/automation";
import type { TriggerStore } from "@lite-harness/automation";

const trigger = {
  id: "daily-report",
  intervalMs: 60_000,
  nextFireAt: 1_000,
  payload: { agent: "reporter", workspace: "ops" },
  missedRunPolicy: "skip" as const,
};

describe("automation scheduling", () => {
  it("claims, fences, and completes an in-memory trigger", async () => {
    await exerciseStore("memory", new InMemoryTriggerStore());
  });

  it("claims, fences, and completes a SQLite trigger", async () => {
    const store = new SqliteTriggerStore(":memory:");
    try { await exerciseStore("sqlite", store); } finally { store.close(); }
  });

  async function exerciseStore(_name: string, store: TriggerStore): Promise<void> {
    store.put(trigger);
    expect(store.claimDue(1_000, "worker-a", 30_000)).toMatchObject([{ id: trigger.id, leaseOwner: "worker-a" }]);
    expect(store.claimDue(1_000, "worker-b", 30_000)).toEqual([]);
    expect(store.complete(trigger.id, "worker-b", 1_000)).toBe(false);
    expect(store.complete(trigger.id, "worker-a", 1_000)).toBe(true);
    expect(store.claimDue(1_001, "worker-b", 30_000)).toEqual([]);
    expect(store.claimDue(61_000, "worker-b", 30_000)).toHaveLength(1);
  }

  it("records scheduler failures as retryable without losing the trigger", async () => {
    const store = new InMemoryTriggerStore();
    store.put({ ...trigger, id: "failing", oneShot: true });
    const scheduler = new SchedulerEngine(store, "scheduler", async () => { throw new Error("connector_down"); });
    await expect(scheduler.tick(1_000)).resolves.toBe(0);
    expect(store.claimDue(1_000, "observer", 30_000)).toHaveLength(0);
    expect(store.claimDue(31_000, "observer", 30_000)).toHaveLength(1);
  });
});
