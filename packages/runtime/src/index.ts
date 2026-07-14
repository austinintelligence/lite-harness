import type { ArtifactRecord, InternalPrincipal, ToolCall, ToolDefinition, ToolResult } from "@lite-harness/contracts";

export interface ToolExecutionContext {
  workspaceId: string;
  runId?: string;
  principal?: InternalPrincipal;
  call: ToolCall;
  signal?: AbortSignal;
}

export interface ToolRuntime {
  execute(params: ToolExecutionContext): Promise<ToolResult>;
  listTools?(): readonly ToolDefinition[];
}

export type BrokeredToolHandler = (params: ToolExecutionContext) => Promise<ToolResult>;

/**
 * Routes trusted host capabilities without teaching the agent runtime or an
 * untrusted container about Manager internals. Unregistered tools fall through
 * to the configured runtime.
 */
export class BrokeredToolRuntime implements ToolRuntime {
  readonly #handlers = new Map<string, BrokeredToolHandler>();
  readonly #definitions = new Map<string, ToolDefinition>();

  constructor(private readonly inner: ToolRuntime) {}

  register(name: string, handler: BrokeredToolHandler, definition?: Omit<ToolDefinition, "name">): void {
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(name)) throw new Error(`Invalid brokered tool name: ${name}`);
    if (this.#handlers.has(name)) throw new Error(`Brokered tool is already registered: ${name}`);
    this.#handlers.set(name, handler);
    this.#definitions.set(name, definition ? { name, ...definition } : {
      name,
      description: `Invoke the Manager-brokered ${name} capability.`,
      inputSchema: { type: "object", additionalProperties: true },
    });
  }

  listTools(): readonly ToolDefinition[] {
    const combined = new Map((this.inner.listTools?.() ?? []).map((definition) => [definition.name, definition]));
    for (const [name, definition] of this.#definitions) combined.set(name, definition);
    return [...combined.values()];
  }

  async execute(params: ToolExecutionContext): Promise<ToolResult> {
    const handler = this.#handlers.get(params.call.name);
    return handler ? await handler(params) : await this.inner.execute(params);
  }
}

export class InMemoryToolRuntime implements ToolRuntime {
  readonly #workspaces = new Map<string, Map<string, string>>();

  listTools(): readonly ToolDefinition[] { return WORKSPACE_TOOL_DEFINITIONS; }

  async execute(params: ToolExecutionContext): Promise<ToolResult> {
    params.signal?.throwIfAborted();
    const files = this.#workspaces.get(params.workspaceId) ?? new Map<string, string>();
    this.#workspaces.set(params.workspaceId, files);

    if (params.call.name === "write_file") {
      const path = requireString(params.call.arguments.path, "path");
      const content = requireString(params.call.arguments.content, "content");
      validateWorkspacePath(path);
      files.set(path, content);
      return {
        callId: params.call.id,
        ok: true,
        content: `Wrote ${content.length} bytes to ${path}`,
        metadata: { path, bytes: content.length },
      };
    }

    if (params.call.name === "read_file") {
      const path = requireString(params.call.arguments.path, "path");
      validateWorkspacePath(path);
      const content = files.get(path);
      return content === undefined
        ? { callId: params.call.id, ok: false, content: `File not found: ${path}` }
        : { callId: params.call.id, ok: true, content, metadata: { path } };
    }

    return {
      callId: params.call.id,
      ok: false,
      content: `Unsupported tool: ${params.call.name}`,
    };
  }

  readFile(workspaceId: string, path: string): string | undefined {
    return this.#workspaces.get(workspaceId)?.get(path);
  }
}

export interface ArtifactPublisher {
  publish(params: {
    runId: string;
    workspaceId: string;
    principal: InternalPrincipal;
    path: string;
    mediaType: string;
    data: Buffer;
  }): Promise<ArtifactRecord> | ArtifactRecord;
}

export class ArtifactPublishingRuntime implements ToolRuntime {
  constructor(
    private readonly inner: ToolRuntime,
    private readonly artifacts: ArtifactPublisher,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  listTools(): readonly ToolDefinition[] {
    return [...(this.inner.listTools?.() ?? []), ARTIFACT_TOOL_DEFINITION];
  }

  async execute(params: ToolExecutionContext): Promise<ToolResult> {
    if (params.call.name !== "artifact_publish") return await this.inner.execute(params);
    params.signal?.throwIfAborted();
    if (!params.runId || !params.principal) throw new Error("Artifact publication requires an owned run context");
    const path = requireString(params.call.arguments.path, "path");
    const mediaType = requireString(params.call.arguments.mediaType, "mediaType");
    validateWorkspacePath(path);
    const data = typeof params.call.arguments.dataBase64 === "string"
      ? Buffer.from(params.call.arguments.dataBase64, "base64")
      : Buffer.from(requireString(params.call.arguments.content, "content"), "utf8");
    if (data.length > this.maxBytes) throw new Error(`Artifact exceeds ${this.maxBytes} bytes`);
    const record = await this.artifacts.publish({
      runId: params.runId,
      workspaceId: params.workspaceId,
      principal: params.principal,
      path,
      mediaType,
      data,
    });
    return {
      callId: params.call.id,
      ok: true,
      content: `Published artifact ${record.id}`,
      metadata: { artifactId: record.id, path: record.path, sha256: record.sha256, sizeBytes: record.sizeBytes },
    };
  }
}

export const WORKSPACE_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "read_file", description: "Read a UTF-8 file from the current workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  }),
  Object.freeze({
    name: "write_file", description: "Write UTF-8 content to a file in the current workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  }),
]);

const ARTIFACT_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: "artifact_publish", description: "Publish owned text or base64 data as a downloadable run artifact.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, mediaType: { type: "string" }, content: { type: "string" }, dataBase64: { type: "string" } },
    required: ["path", "mediaType"], additionalProperties: false,
  },
});

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

export function validateWorkspacePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Unsafe workspace path: ${path}`);
  }
}
