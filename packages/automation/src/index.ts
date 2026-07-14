import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface IntervalTrigger {
  id: string;
  intervalMs: number;
  nextFireAt: number;
  payload: Record<string, unknown>;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  oneShot?: boolean;
  jitterMs?: number;
}

export interface TriggerStore {
  put(trigger: IntervalTrigger): void;
  claimDue(now: number, owner: string, leaseMs: number): IntervalTrigger[];
  complete(id: string, owner: string, firedAt: number): boolean;
  fail?(id: string, owner: string, retryAt: number, errorCode: string): boolean;
}

export class InMemoryTriggerStore implements TriggerStore {
  readonly #triggers = new Map<string, IntervalTrigger>();

  put(trigger: IntervalTrigger): void {
    validateTrigger(trigger);
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
    if (trigger.oneShot) trigger.nextFireAt = Number.MAX_SAFE_INTEGER;
    else trigger.nextFireAt = nextOccurrence(trigger, firedAt);
    trigger.leaseOwner = undefined;
    trigger.leaseExpiresAt = undefined;
    return true;
  }

  fail(id: string, owner: string, retryAt: number): boolean {
    const trigger = this.#triggers.get(id);
    if (!trigger || trigger.leaseOwner !== owner) return false;
    trigger.nextFireAt = retryAt;
    trigger.leaseOwner = undefined;
    trigger.leaseExpiresAt = undefined;
    return true;
  }
}

export class SqliteTriggerStore implements TriggerStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL, next_fire_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL, one_shot INTEGER NOT NULL DEFAULT 0, jitter_ms INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1, lease_owner TEXT, lease_expires_at INTEGER,
        last_fired_at INTEGER, last_error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS trigger_firings (
        trigger_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, owner TEXT NOT NULL,
        status TEXT NOT NULL, completed_at INTEGER, error_code TEXT,
        PRIMARY KEY(trigger_id, scheduled_at)
      );
    `);
  }

  put(trigger: IntervalTrigger): void {
    validateTrigger(trigger);
    this.#database.prepare(`
      INSERT INTO triggers(id, interval_ms, next_fire_at, payload_json, one_shot, jitter_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET interval_ms=excluded.interval_ms, next_fire_at=excluded.next_fire_at,
        payload_json=excluded.payload_json, one_shot=excluded.one_shot, jitter_ms=excluded.jitter_ms, enabled=1
    `).run(trigger.id, trigger.intervalMs, trigger.nextFireAt, JSON.stringify(trigger.payload), trigger.oneShot ? 1 : 0, trigger.jitterMs ?? 0);
  }

  ensure(trigger: IntervalTrigger): void {
    validateTrigger(trigger);
    this.#database.prepare(`
      INSERT OR IGNORE INTO triggers(id, interval_ms, next_fire_at, payload_json, one_shot, jitter_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(trigger.id, trigger.intervalMs, trigger.nextFireAt, JSON.stringify(trigger.payload), trigger.oneShot ? 1 : 0, trigger.jitterMs ?? 0);
  }

  claimDue(now: number, owner: string, leaseMs: number): IntervalTrigger[] {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#database.prepare(`SELECT * FROM triggers WHERE enabled = 1 AND next_fire_at <= ?
        AND (lease_owner IS NULL OR lease_expires_at <= ?) ORDER BY next_fire_at`).all(now, now) as unknown as TriggerRow[];
      const claimed: IntervalTrigger[] = [];
      for (const row of rows) {
        const result = this.#database.prepare(`UPDATE triggers SET lease_owner = ?, lease_expires_at = ?
          WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at <= ?)`).run(owner, now + leaseMs, row.id, now);
        if (result.changes !== 1) continue;
        this.#database.prepare(`INSERT OR IGNORE INTO trigger_firings(trigger_id, scheduled_at, owner, status)
          VALUES (?, ?, ?, 'CLAIMED')`).run(row.id, row.next_fire_at, owner);
        claimed.push(toTrigger({ ...row, lease_owner: owner, lease_expires_at: now + leaseMs }));
      }
      this.#database.exec("COMMIT");
      return claimed;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  complete(id: string, owner: string, firedAt: number): boolean {
    const row = this.#database.prepare("SELECT * FROM triggers WHERE id = ? AND lease_owner = ?").get(id, owner) as TriggerRow | undefined;
    if (!row) return false;
    const trigger = toTrigger(row);
    const next = trigger.oneShot ? Number.MAX_SAFE_INTEGER : nextOccurrence(trigger, firedAt);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(`UPDATE triggers SET next_fire_at = ?, enabled = ?, lease_owner = NULL,
        lease_expires_at = NULL, last_fired_at = ?, last_error_code = NULL WHERE id = ? AND lease_owner = ?`)
        .run(next, trigger.oneShot ? 0 : 1, firedAt, id, owner);
      if (result.changes === 1) this.#database.prepare(`UPDATE trigger_firings SET status='COMPLETED', completed_at=?
        WHERE trigger_id=? AND scheduled_at=? AND owner=?`).run(firedAt, id, row.next_fire_at, owner);
      this.#database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  fail(id: string, owner: string, retryAt: number, errorCode: string): boolean {
    const row = this.#database.prepare("SELECT next_fire_at FROM triggers WHERE id = ? AND lease_owner = ?").get(id, owner) as { next_fire_at: number } | undefined;
    if (!row) return false;
    const result = this.#database.prepare(`UPDATE triggers SET next_fire_at=?, lease_owner=NULL,
      lease_expires_at=NULL, last_error_code=? WHERE id=? AND lease_owner=?`).run(retryAt, errorCode, id, owner);
    if (result.changes === 1) this.#database.prepare(`UPDATE trigger_firings SET status='FAILED', completed_at=?, error_code=?
      WHERE trigger_id=? AND scheduled_at=? AND owner=?`).run(Date.now(), errorCode, id, row.next_fire_at, owner);
    return result.changes === 1;
  }

  close(): void { this.#database.close(); }

  listFirings(id: string): TriggerFiring[] {
    return (this.#database.prepare(`SELECT trigger_id, scheduled_at, owner, status, completed_at, error_code
      FROM trigger_firings WHERE trigger_id = ? ORDER BY scheduled_at`).all(id) as unknown as TriggerFiringRow[]).map((row) => ({
      triggerId: row.trigger_id, scheduledAt: row.scheduled_at, owner: row.owner,
      status: row.status as TriggerFiring["status"],
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    }));
  }
}

export interface TriggerFiring {
  triggerId: string;
  scheduledAt: number;
  owner: string;
  status: "CLAIMED" | "COMPLETED" | "FAILED";
  completedAt?: number;
  errorCode?: string;
}

export class SchedulerEngine {
  constructor(
    private readonly store: TriggerStore,
    private readonly owner: string,
    private readonly createRun: (trigger: IntervalTrigger) => Promise<void>,
  ) {}

  async tick(now = Date.now()): Promise<number> {
    const due = this.store.claimDue(now, this.owner, 30_000);
    let completed = 0;
    for (const trigger of due) {
      try {
        await this.createRun(trigger);
        if (this.store.complete(trigger.id, this.owner, now)) completed += 1;
      } catch (error) {
        this.store.fail?.(trigger.id, this.owner, now + 30_000, error instanceof Error ? error.name : "run_start_failed");
      }
    }
    return completed;
  }
}

interface TriggerRow {
  id: string; interval_ms: number; next_fire_at: number; payload_json: string;
  one_shot: number; jitter_ms: number; lease_owner: string | null; lease_expires_at: number | null;
}

interface TriggerFiringRow {
  trigger_id: string; scheduled_at: number; owner: string; status: string;
  completed_at: number | null; error_code: string | null;
}

function toTrigger(row: TriggerRow): IntervalTrigger {
  return {
    id: row.id, intervalMs: row.interval_ms, nextFireAt: row.next_fire_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    ...(row.one_shot ? { oneShot: true } : {}), ...(row.jitter_ms ? { jitterMs: row.jitter_ms } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
  };
}

function validateTrigger(trigger: IntervalTrigger): void {
  if (!trigger.oneShot && trigger.intervalMs < 1_000) throw new Error("Trigger interval must be at least one second");
  if (trigger.oneShot && trigger.intervalMs < 0) throw new Error("One-shot trigger interval cannot be negative");
  if (!Number.isSafeInteger(trigger.nextFireAt) || trigger.nextFireAt < 0) throw new Error("Trigger nextFireAt is invalid");
  if ((trigger.jitterMs ?? 0) < 0 || (trigger.jitterMs ?? 0) > Math.max(trigger.intervalMs, 86_400_000)) throw new Error("Trigger jitter is invalid");
}

function nextOccurrence(trigger: IntervalTrigger, firedAt: number): number {
  const missed = Math.max(1, Math.floor((firedAt - trigger.nextFireAt) / trigger.intervalMs) + 1);
  const base = trigger.nextFireAt + missed * trigger.intervalMs;
  const jitter = trigger.jitterMs ?? 0;
  if (!jitter) return base;
  const value = createHash("sha256").update(`${trigger.id}:${base}`).digest().readUInt32BE(0);
  return base + (value % (jitter + 1));
}
