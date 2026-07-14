export type ContextBlockKind = "instructions" | "conversation" | "tool-state" | "source" | "logs" | "memory";

export interface ContextBlock {
  id: string;
  kind: ContextBlockKind;
  exactText: string;
  lossyEligible: boolean;
  sensitive: boolean;
}

export interface RenderedContextBlock {
  id: string;
  kind: ContextBlockKind;
  representation: "text" | "image";
  content: string | readonly string[];
  exactRecoveryAvailable: true;
}

export interface ContextRenderer {
  render(block: ContextBlock, modelId: string): Promise<string | readonly string[]>;
}

export const PXPIPE_EVALUATED_VERSION = "0.7.1";
export const PXPIPE_EVALUATED_COMMIT = "0dce007d4c072268eb63e0b0c07e758914f1b731";

export class OptionalPxpipeRenderer implements ContextRenderer {
  constructor(private readonly limits: { maxTextBytes?: number; maxPages?: number; maxImageBytes?: number } = {}) {}

  async render(block: ContextBlock): Promise<readonly string[]> {
    if (Buffer.byteLength(block.exactText) > (this.limits.maxTextBytes ?? 2 * 1024 * 1024)) throw new Error("pxpipe context block is too large");
    const moduleName: string = "pxpipe-proxy";
    let loaded: unknown;
    try { loaded = await import(moduleName); }
    catch { throw new Error(`Optional pxpipe-proxy@${PXPIPE_EVALUATED_VERSION} is not installed`); }
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
  readonly #blocks = new Map<string, ContextBlock>();

  put(block: ContextBlock): void {
    if (!block.id || !block.exactText) throw new Error("Context block id and exact text are required");
    this.#blocks.set(block.id, Object.freeze({ ...block }));
  }

  fetchExact(blockId: string): string {
    const block = this.#blocks.get(blockId);
    if (!block) throw new Error(`Context block not found: ${blockId}`);
    return block.exactText;
  }

  list(): ContextBlock[] {
    return [...this.#blocks.values()];
  }
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
    scope?: { appId: string; tenantId: string },
  ): Promise<RenderedContextBlock[]> {
    const mayRender = mode === "conservative" && this.enabledModels.has(modelId) &&
      (!this.policy || Boolean(scope && this.policy.gate.allows(scope.appId, modelId)));
    return Promise.all(this.store.list().map(async (block) => {
      if (!mayRender || !block.lossyEligible || block.sensitive || block.kind === "source" || block.kind === "tool-state") {
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
        return { id: block.id, kind: block.kind, representation: "image", content: images, exactRecoveryAvailable: true };
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
    exactRecoveryAvailable: true,
  };
}
import { createHash } from "node:crypto";
