export interface IntervalTrigger {
  id: string;
  intervalMs: number;
  nextFireAt: number;
  payload: Record<string, unknown>;
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

export class InMemoryTriggerStore {
  readonly #triggers = new Map<string, IntervalTrigger>();

  put(trigger: IntervalTrigger): void {
    if (trigger.intervalMs < 1_000) throw new Error("Trigger interval must be at least one second");
    this.#triggers.set(trigger.id, { ...trigger, payload: { ...trigger.payload } });
  }

  claimDue(now: number, owner: string, leaseMs: number): IntervalTrigger[] {
    const claimed: IntervalTrigger[] = [];
    for (const trigger of this.#triggers.values()) {
      if (trigger.nextFireAt > now) continue;
      if (trigger.leaseOwner && (trigger.leaseExpiresAt ?? 0) > now && trigger.leaseOwner !== owner) continue;
      trigger.leaseOwner = owner;
      trigger.leaseExpiresAt = now + leaseMs;
      claimed.push({ ...trigger, payload: { ...trigger.payload } });
    }
    return claimed;
  }

  complete(id: string, owner: string, firedAt: number): boolean {
    const trigger = this.#triggers.get(id);
    if (!trigger || trigger.leaseOwner !== owner) return false;
    const missed = Math.max(1, Math.floor((firedAt - trigger.nextFireAt) / trigger.intervalMs) + 1);
    trigger.nextFireAt += missed * trigger.intervalMs;
    trigger.leaseOwner = undefined;
    trigger.leaseExpiresAt = undefined;
    return true;
  }
}

export class SchedulerEngine {
  constructor(
    private readonly store: InMemoryTriggerStore,
    private readonly owner: string,
    private readonly createRun: (trigger: IntervalTrigger) => Promise<void>,
  ) {}

  async tick(now = Date.now()): Promise<number> {
    const due = this.store.claimDue(now, this.owner, 30_000);
    let completed = 0;
    for (const trigger of due) {
      await this.createRun(trigger);
      if (this.store.complete(trigger.id, this.owner, now)) completed += 1;
    }
    return completed;
  }
}
