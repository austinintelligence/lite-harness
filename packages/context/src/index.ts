import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type ContextBlockKind = "instructions" | "conversation" | "tool-state" | "source" | "logs" | "memory";

export interface ContextBlock {
  id: string;
  kind: ContextBlockKind;
  exactText: string;
  lossyEligible: boolean;
  sensitive: boolean;
  provenance?: string;
  timeRange?: { start?: string; end?: string };
}

export interface RenderedContextBlock {
  id: string;
  kind: ContextBlockKind;
  representation: "text" | "image";
  content: string | readonly string[];
  nativeLabel: string;
  exactRecoveryAvailable: true;
}

export interface ContextRenderer {
  render(block: ContextBlock, modelId: string): Promise<string | readonly string[]>;
}

export const PXPIPE_EVALUATED_VERSION = "0.8.0";
export const PXPIPE_EVALUATED_COMMIT = "7dd54d395d119f5f822da5c1944ba5afbb02fa88";

export function installedPxpipeVersion(): string | undefined {
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let current = start;
    while (true) {
      try {
        const manifest = JSON.parse(readFileSync(join(current, "node_modules", "pxpipe-proxy", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === "pxpipe-proxy") return typeof manifest.version === "string" ? manifest.version : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return undefined;
}

export function assertEvaluatedPxpipeVersion(): void {
  const installed = installedPxpipeVersion();
  if (!installed) throw new Error(`Optional pxpipe-proxy@${PXPIPE_EVALUATED_VERSION} is not installed`);
  if (installed !== PXPIPE_EVALUATED_VERSION) {
    throw new Error(`Installed pxpipe-proxy@${installed} does not match evaluated version ${PXPIPE_EVALUATED_VERSION}`);
  }
}

export class OptionalPxpipeRenderer implements ContextRenderer {
  constructor(private readonly limits: { maxTextBytes?: number; maxPages?: number; maxImageBytes?: number } = {}) {}

  async render(block: ContextBlock): Promise<readonly string[]> {
    if (Buffer.byteLength(block.exactText) > (this.limits.maxTextBytes ?? 2 * 1024 * 1024)) throw new Error("pxpipe context block is too large");
    assertEvaluatedPxpipeVersion();
    const moduleName: string = "pxpipe-proxy";
    let loaded: unknown;
    try { loaded = await import(moduleName); }
    catch { throw new Error(`Optional pxpipe-proxy@${PXPIPE_EVALUATED_VERSION} could not be loaded`); }
    const render = (loaded as { renderTextToImages?: (text: string, options?: { reflow?: boolean }) => Promise<{ pages?: Array<{ png?: Uint8Array }> }> }).renderTextToImages;
    if (typeof render !== "function") throw new Error("pxpipe renderer export is unavailable");
    const result = await render(block.exactText, { reflow: true });
    const pages = result.pages ?? [];
    if (pages.length > (this.limits.maxPages ?? 64)) throw new Error("pxpipe returned too many pages");
    let totalBytes = 0;
    const images = pages.map((page) => {
      if (!(page.png instanceof Uint8Array)) throw new Error("pxpipe returned a page without PNG bytes");
      totalBytes += page.png.byteLength;
      if (totalBytes > (this.limits.maxImageBytes ?? 32 * 1024 * 1024)) throw new Error("pxpipe output is too large");
      return `data:image/png;base64,${Buffer.from(page.png).toString("base64")}`;
    });
    if (images.length === 0) throw new Error("pxpipe returned no rendered pages");
    return images;
  }
}

export interface ContextRenderEvaluation {
  modelId: string;
  blockId: string;
  characters: number;
  pages: number;
  imageBytes: number;
  renderMilliseconds: number;
  exactRecoveryVerified: boolean;
  estimatedTextTokens: number;
  verdict: "measurement-only";
}

export async function evaluateContextRenderer(
  store: ContextStore,
  renderer: ContextRenderer,
  block: ContextBlock,
  modelId: string,
): Promise<ContextRenderEvaluation> {
  store.put(block);
  const started = performance.now();
  const rendered = await renderer.render(block, modelId);
  const images = Array.isArray(rendered) ? rendered : [rendered];
  if (!images.every((image) => typeof image === "string" && image.startsWith("data:image/"))) {
    throw new Error("Context renderer returned a non-image page");
  }
  const imageBytes = images.reduce((total, image) => {
    const payload = image.slice(image.indexOf(",") + 1);
    return total + Buffer.from(payload, "base64").length;
  }, 0);
  return {
    modelId, blockId: block.id, characters: block.exactText.length, pages: images.length,
    imageBytes, renderMilliseconds: performance.now() - started,
    exactRecoveryVerified: store.fetchExact(block.id) === block.exactText,
    estimatedTextTokens: Math.ceil(block.exactText.length / 4),
    verdict: "measurement-only",
  };
}

export class ContextStore {
  readonly #database: DatabaseSync;

  constructor(path = ":memory:") {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS context_blocks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        exact_text TEXT NOT NULL,
        exact_sha256 TEXT NOT NULL,
        lossy_eligible INTEGER NOT NULL CHECK (lossy_eligible IN (0, 1)),
        sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
        provenance TEXT,
        time_start TEXT,
        time_end TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  put(block: ContextBlock): void {
    if (!block.id || !block.exactText) throw new Error("Context block id and exact text are required");
    if (!CONTEXT_BLOCK_KINDS.has(block.kind)) throw new Error(`Unsupported context block kind: ${block.kind}`);
    const digest = createHash("sha256").update(block.exactText).digest("hex");
    const existing = this.#database.prepare("SELECT exact_sha256 FROM context_blocks WHERE id = ?").get(block.id) as { exact_sha256: string } | undefined;
    if (existing) {
      if (existing.exact_sha256 !== digest) throw new Error(`Context block is immutable: ${block.id}`);
      return;
    }
    this.#database.prepare(`
      INSERT INTO context_blocks (
        id, kind, exact_text, exact_sha256, lossy_eligible, sensitive,
        provenance, time_start, time_end, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      block.id, block.kind, block.exactText, digest, block.lossyEligible ? 1 : 0, block.sensitive ? 1 : 0,
      block.provenance ?? null, block.timeRange?.start ?? null, block.timeRange?.end ?? null, new Date().toISOString(),
    );
  }

  fetchExact(blockId: string): string {
    const block = this.#database.prepare("SELECT exact_text FROM context_blocks WHERE id = ?").get(blockId) as { exact_text: string } | undefined;
    if (!block) throw new Error(`Context block not found: ${blockId}`);
    return block.exact_text;
  }

  list(): ContextBlock[] {
    const rows = this.#database.prepare(`
      SELECT id, kind, exact_text, lossy_eligible, sensitive, provenance, time_start, time_end
      FROM context_blocks ORDER BY created_at, id
    `).all() as Array<{
      id: string; kind: ContextBlockKind; exact_text: string; lossy_eligible: number; sensitive: number;
      provenance: string | null; time_start: string | null; time_end: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id, kind: row.kind, exactText: row.exact_text,
      lossyEligible: row.lossy_eligible === 1, sensitive: row.sensitive === 1,
      ...(row.provenance ? { provenance: row.provenance } : {}),
      ...(row.time_start || row.time_end ? { timeRange: {
        ...(row.time_start ? { start: row.time_start } : {}), ...(row.time_end ? { end: row.time_end } : {}),
      } } : {}),
    }));
  }

  close(): void { this.#database.close(); }
}

export class ContextOptimizationGate {
  constructor(private readonly policy: {
    enabled: boolean;
    allowedApps: ReadonlySet<string>;
    allowedModels: ReadonlySet<string>;
    killedApps?: ReadonlySet<string>;
    killedModels?: ReadonlySet<string>;
  }) {}

  allows(appId: string, modelId: string): boolean {
    return this.policy.enabled && this.policy.allowedApps.has(appId) && this.policy.allowedModels.has(modelId) &&
      !this.policy.killedApps?.has(appId) && !this.policy.killedModels?.has(modelId);
  }
}

export class TenantContextRenderCache {
  readonly #entries = new Map<string, readonly string[]>();
  constructor(private readonly maxEntries = 128) {}

  get(tenantId: string, modelId: string, block: ContextBlock): readonly string[] | undefined {
    const key = contextCacheKey(tenantId, modelId, block);
    const value = this.#entries.get(key);
    if (value) { this.#entries.delete(key); this.#entries.set(key, value); }
    return value;
  }

  put(tenantId: string, modelId: string, block: ContextBlock, images: readonly string[]): void {
    const key = contextCacheKey(tenantId, modelId, block);
    this.#entries.set(key, Object.freeze([...images]));
    while (this.#entries.size > this.maxEntries) this.#entries.delete(this.#entries.keys().next().value as string);
  }
}

export class ConservativeContextCompiler {
  constructor(
    private readonly store: ContextStore,
    private readonly renderer: ContextRenderer,
    private readonly enabledModels: ReadonlySet<string>,
    private readonly policy?: { gate: ContextOptimizationGate; cache?: TenantContextRenderCache },
  ) {}

  async compile(
    modelId: string,
    mode: "off" | "conservative" = "off",
    scope?: { appId: string; tenantId: string; modelCapabilities?: readonly string[] },
  ): Promise<RenderedContextBlock[]> {
    const mayRender = mode === "conservative" && this.enabledModels.has(modelId) &&
      Boolean(scope?.modelCapabilities?.includes("vision")) &&
      (!this.policy || Boolean(scope && this.policy.gate.allows(scope.appId, modelId)));
    return Promise.all(this.store.list().map(async (block) => {
      if (!mayRender || !block.lossyEligible || block.sensitive || block.exactText.length < 1_024 ||
          (block.kind !== "logs" && block.kind !== "memory")) {
        return asText(block);
      }
      try {
        const cached = scope ? this.policy?.cache?.get(scope.tenantId, modelId, block) : undefined;
        const rendered = cached ?? await this.renderer.render(block, modelId);
        const images = Array.isArray(rendered) ? rendered : [rendered];
        if (!images.length || !images.every((image) => typeof image === "string" && image.startsWith("data:image/"))) {
          throw new Error("Renderer did not return image data URLs");
        }
        if (scope && !cached) this.policy?.cache?.put(scope.tenantId, modelId, block, images);
        return {
          id: block.id, kind: block.kind, representation: "image", content: images,
          nativeLabel: opticalLabel(block), exactRecoveryAvailable: true,
        };
      } catch {
        return asText(block);
      }
    }));
  }
}

function contextCacheKey(tenantId: string, modelId: string, block: ContextBlock): string {
  return `${tenantId}\0${modelId}\0${block.id}\0${createHash("sha256").update(block.exactText).digest("hex")}`;
}

function asText(block: ContextBlock): RenderedContextBlock {
  return {
    id: block.id,
    kind: block.kind,
    representation: "text",
    content: block.exactText,
    nativeLabel: block.exactText,
    exactRecoveryAvailable: true,
  };
}

function opticalLabel(block: ContextBlock): string {
  const provenance = block.provenance ? ` from ${block.provenance}` : "";
  return `Optical context ${block.id} (${block.kind})${provenance}. Exact canonical text is retained for recovery.`;
}

const CONTEXT_BLOCK_KINDS = new Set<ContextBlockKind>(["instructions", "conversation", "tool-state", "source", "logs", "memory"]);
