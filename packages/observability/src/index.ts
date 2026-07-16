import { appendFileSync, chmodSync, mkdirSync, rmSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ObservabilityScalar = string | number | boolean;
export type ObservabilityAttributes = Record<string, ObservabilityScalar | undefined>;

export interface TraceContext {
  traceId: string;
  spanId: string;
}

export interface ObservabilityEvent {
  schemaVersion: 1;
  at: string;
  kind: "metric" | "audit" | "trace";
  name: string;
  traceId: string;
  spanId?: string;
  durationMs?: number;
  attributes: Record<string, ObservabilityScalar>;
}

export interface ObservabilitySink {
  emit(event: ObservabilityEvent): void;
}

export interface ObservabilitySnapshot {
  counters: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; max: number }>;
  events: ObservabilityEvent[];
}

export interface TraceSpan extends TraceContext {
  end(attributes?: ObservabilityAttributes): ObservabilityEvent | undefined;
}

const SECRET_KEY = /(?:authorization|api[_-]?key|cookie|credential|password|secret|token)/i;
const CONTENT_KEY = /(?:body|content|file|input|message|output|path|prompt|query|stack|text)/i;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_NAME = /^[a-z][a-z0-9_.:-]{0,127}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Keep telemetry useful without allowing prompts, file contents, local paths,
 * credentials, or exception stacks to cross the observability boundary.
 */
export function sanitizeObservabilityAttributes(input: ObservabilityAttributes = {}): Record<string, ObservabilityScalar> {
  const output: Record<string, ObservabilityScalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_KEY.test(key) || value === undefined || CONTENT_KEY.test(key)) continue;
    if (SECRET_KEY.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value) && Number.isSafeInteger(value)) output[key] = value;
      else if (Number.isFinite(value)) output[key] = Number(value.toFixed(6));
      continue;
    }
    if (typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    output[key] = value.replace(CONTROL_CHARS, " ").slice(0, 256);
  }
  return output;
}

export class JsonlObservabilitySink implements ObservabilitySink {
  constructor(private readonly path: string, private readonly maxBytes = 10 * 1024 * 1024) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(path, 0o600); } catch { /* created on first write */ }
  }

  emit(event: ObservabilityEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    let size = 0;
    try { size = statSync(this.path).size; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size + Buffer.byteLength(line) > this.maxBytes) {
      try { rmSync(`${this.path}.1`, { force: true }); } catch { /* best effort rotation */ }
      try { renameSync(this.path, `${this.path}.1`); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
  }
}

export class StructuredObservability {
  readonly #events: ObservabilityEvent[] = [];
  readonly #counters = new Map<string, number>();
  readonly #histograms = new Map<string, { count: number; sum: number; max: number }>();
  readonly #sinks: readonly ObservabilitySink[];
  readonly #maxEvents: number;
  readonly #now: () => number;

  constructor(options: { sinks?: readonly ObservabilitySink[]; maxEvents?: number; now?: () => number } = {}) {
    this.#sinks = options.sinks ?? [];
    this.#maxEvents = options.maxEvents ?? 2_048;
    if (!Number.isSafeInteger(this.#maxEvents) || this.#maxEvents < 1 || this.#maxEvents > 100_000) {
      throw new Error("Observability event bound must be a positive safe integer");
    }
    this.#now = options.now ?? Date.now;
  }

  startTrace(name: string, attributes: ObservabilityAttributes = {}, parent?: TraceContext): TraceSpan {
    assertName(name);
    const traceId = parent?.traceId ?? randomUUID().replaceAll("-", "");
    const spanId = randomUUID().replaceAll("-", "").slice(0, 16);
    const startedAt = this.#now();
    let ended = false;
    return {
      traceId,
      spanId,
      end: (endAttributes = {}) => {
        if (ended) return undefined;
        ended = true;
        const durationMs = Math.max(0, this.#now() - startedAt);
        const event = this.#record({
          kind: "trace", name, traceId, spanId, durationMs,
          attributes: { ...attributes, ...endAttributes },
        });
        this.observe(`trace.${name}.duration_ms`, durationMs, { traceId });
        this.counter(`trace.${name}.completed`, 1, { traceId });
        return event;
      },
    };
  }

  counter(name: string, value = 1, attributes: ObservabilityAttributes = {}): void {
    assertName(name);
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new Error("Metric counter values must be finite safe integers");
    const next = (this.#counters.get(name) ?? 0) + value;
    if (!Number.isSafeInteger(next)) throw new Error("Metric counter aggregate must remain a finite safe integer");
    this.#counters.set(name, next);
    this.#record({ kind: "metric", name, traceId: attributeTraceId(attributes), attributes: { ...attributes, value } });
  }

  observe(name: string, value: number, attributes: ObservabilityAttributes = {}): void {
    assertName(name);
    if (!Number.isFinite(value) || value < 0) throw new Error("Metric observations must be finite non-negative numbers");
    const current = this.#histograms.get(name) ?? { count: 0, sum: 0, max: 0 };
    const next = {
      count: current.count + 1,
      sum: current.sum + value,
      max: Math.max(current.max, value),
    };
    if (!Number.isSafeInteger(next.count) || !Number.isFinite(next.sum) || !Number.isFinite(next.max)) {
      throw new Error("Metric histogram aggregate must remain finite with a safe count");
    }
    this.#histograms.set(name, next);
    this.#record({ kind: "metric", name, traceId: attributeTraceId(attributes), attributes: { ...attributes, value } });
  }

  audit(name: string, outcome: "accepted" | "rejected" | "completed" | "failed", attributes: ObservabilityAttributes = {}, context?: TraceContext): void {
    assertName(name);
    this.#record({ kind: "audit", name, traceId: context?.traceId ?? attributeTraceId(attributes), spanId: context?.spanId, attributes: { ...attributes, outcome } });
  }

  snapshot(): ObservabilitySnapshot {
    return {
      counters: Object.fromEntries(this.#counters),
      histograms: Object.fromEntries([...this.#histograms].map(([name, value]) => [name, { ...value }])),
      events: this.#events.map((event) => ({ ...event, attributes: { ...event.attributes } })),
    };
  }

  #record(input: { kind: ObservabilityEvent["kind"]; name: string; traceId?: string; spanId?: string; durationMs?: number; attributes?: ObservabilityAttributes }): ObservabilityEvent {
    const event: ObservabilityEvent = {
      schemaVersion: 1,
      at: new Date(this.#now()).toISOString(),
      kind: input.kind,
      name: input.name,
      traceId: input.traceId ?? randomUUID().replaceAll("-", ""),
      ...(input.spanId ? { spanId: input.spanId } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      attributes: sanitizeObservabilityAttributes(input.attributes),
    };
    this.#events.push(event);
    while (this.#events.length > this.#maxEvents) this.#events.shift();
    for (const sink of this.#sinks) {
      try { sink.emit(event); } catch { /* telemetry must not take down the request path */ }
    }
    return event;
  }
}

function attributeTraceId(attributes: ObservabilityAttributes): string {
  const value = attributes.traceId;
  return typeof value === "string" && /^[a-f0-9]{16,64}$/.test(value) ? value : randomUUID().replaceAll("-", "");
}

function assertName(name: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid observability name: ${name}`);
}
