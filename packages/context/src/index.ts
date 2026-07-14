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
  content: string;
  exactRecoveryAvailable: true;
}

export interface ContextRenderer {
  render(block: ContextBlock, modelId: string): Promise<string>;
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

export class ConservativeContextCompiler {
  constructor(
    private readonly store: ContextStore,
    private readonly renderer: ContextRenderer,
    private readonly enabledModels: ReadonlySet<string>,
  ) {}

  async compile(modelId: string, mode: "off" | "conservative" = "off"): Promise<RenderedContextBlock[]> {
    const mayRender = mode === "conservative" && this.enabledModels.has(modelId);
    return Promise.all(this.store.list().map(async (block) => {
      if (!mayRender || !block.lossyEligible || block.sensitive || block.kind === "source" || block.kind === "tool-state") {
        return asText(block);
      }
      try {
        const image = await this.renderer.render(block, modelId);
        if (!image.startsWith("data:image/")) throw new Error("Renderer did not return an image data URL");
        return { id: block.id, kind: block.kind, representation: "image", content: image, exactRecoveryAvailable: true };
      } catch {
        return asText(block);
      }
    }));
  }
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
