import type { ArtifactRecord, InternalPrincipal, ToolCall, ToolDefinition, ToolResult } from "@lite-harness/contracts";

export interface ToolExecutionContext {
  workspaceId: string;
  runId?: string;
  attemptId?: string;
  /** Fencing token for mutations/readers bound to the active workspace lease. */
  fencingToken?: number;
  /** Exact immutable tool names advertised to the model for this run. */
  allowedTools?: readonly string[];
  principal?: InternalPrincipal;
  call: ToolCall;
  signal?: AbortSignal;
}

export interface ToolRuntime {
  execute(params: ToolExecutionContext): Promise<ToolResult>;
  listTools?(): readonly ToolDefinition[];
  readWorkspaceArtifact?(params: ToolExecutionContext & { path: string; maxBytes: number }): Promise<Buffer>;
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

  readWorkspaceArtifact(params: ToolExecutionContext & { path: string; maxBytes: number }): Promise<Buffer> {
    if (!this.inner.readWorkspaceArtifact) throw new Error("The configured runtime cannot publish workspace artifacts");
    return this.inner.readWorkspaceArtifact(params);
  }
}

export class InMemoryToolRuntime implements ToolRuntime {
  readonly #workspaces = new Map<string, Map<string, string>>();

  listTools(): readonly ToolDefinition[] { return WORKSPACE_TOOL_DEFINITIONS; }

  async execute(params: ToolExecutionContext): Promise<ToolResult> {
    params.signal?.throwIfAborted();
    const identity = workspaceIdentity(params.workspaceId, params.principal);
    const files = this.#workspaces.get(identity) ?? new Map<string, string>();
    this.#workspaces.set(identity, files);

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

  readFile(workspaceId: string, path: string, principal?: InternalPrincipal): string | undefined {
    return this.#workspaces.get(workspaceIdentity(workspaceId, principal))?.get(path);
  }

  async readWorkspaceArtifact(params: ToolExecutionContext & { path: string; maxBytes: number }): Promise<Buffer> {
    params.signal?.throwIfAborted();
    validateWorkspacePath(params.path);
    const value = this.readFile(params.workspaceId, params.path, params.principal);
    if (value === undefined) throw new Error(`Artifact source file not found: ${params.path}`);
    const data = Buffer.from(value, "utf8");
    if (data.length > params.maxBytes) throw new Error(`Artifact exceeds ${params.maxBytes} bytes`);
    return data;
  }
}

function workspaceIdentity(workspaceId: string, principal?: InternalPrincipal): string {
  return principal
    ? `${principal.appId.length}:${principal.appId}:${principal.tenantId.length}:${principal.tenantId}:${principal.userId.length}:${principal.userId}:${workspaceId}`
    : workspaceId;
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
    private readonly validateFence?: (params: ToolExecutionContext) => boolean,
  ) {}

  listTools(): readonly ToolDefinition[] {
    return [...(this.inner.listTools?.() ?? []), ARTIFACT_TOOL_DEFINITION];
  }

  async execute(params: ToolExecutionContext): Promise<ToolResult> {
    if (params.call.name !== "artifact_publish") return await this.inner.execute(params);
    params.signal?.throwIfAborted();
    if (!params.runId || !params.principal) throw new Error("Artifact publication requires an owned run context");
    const path = authorizedWorkspaceArtifactPath(requireString(params.call.arguments.path, "path"));
    const mediaType = requireString(params.call.arguments.mediaType, "mediaType");
    if ("content" in params.call.arguments || "dataBase64" in params.call.arguments) {
      throw new Error("artifact_publish accepts an authorized workspace path, never caller-supplied bytes");
    }
    if (!this.inner.readWorkspaceArtifact) throw new Error("The configured runtime cannot publish workspace artifacts");
    if (this.validateFence && !this.validateFence(params)) throw new Error("Workspace fence is not active");
    const data = await this.inner.readWorkspaceArtifact({ ...params, path, maxBytes: this.maxBytes });
    if (this.validateFence && !this.validateFence(params)) throw new Error("Workspace fence changed while reading artifact");
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

export function authorizedWorkspaceArtifactPath(path: string): string {
  validateWorkspacePath(path);
  return path;
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

const workspaceDirectorySchema = { type: "string", minLength: 1, maxLength: 4_096 } as const;
const packageManagerSchema = { enum: ["pnpm", "npm", "yarn"] } as const;
function stringArraySchema(minItems: number, maxItems: number): Record<string, unknown> {
  return { type: "array", items: { type: "string", maxLength: 16_384 }, minItems, maxItems };
}
function objectSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: "object", properties, ...(required.length ? { required: [...required] } : {}), additionalProperties: false };
}
function projectTaskSchema(fallback: string): Record<string, unknown> {
  return objectSchema({
    manager: packageManagerSchema, script: { type: "string", minLength: 1, maxLength: 128, default: fallback },
    cwd: workspaceDirectorySchema, args: stringArraySchema(0, 64),
  }, []);
}

export const CODING_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "shell_exec", description: "Run a bounded Bash script inside the current isolated workspace container.",
    inputSchema: objectSchema({ script: { type: "string", minLength: 1, maxLength: 65_536 }, cwd: workspaceDirectorySchema }, ["script"]),
  }),
  Object.freeze({
    name: "process_exec", description: "Execute one process directly without shell parsing inside the isolated workspace container.",
    inputSchema: objectSchema({ argv: stringArraySchema(1, 256), cwd: workspaceDirectorySchema }, ["argv"]),
  }),
  Object.freeze({
    name: "search_text", description: "Search workspace text with ripgrep and bounded output.",
    inputSchema: objectSchema({
      pattern: { type: "string", minLength: 1, maxLength: 4_096 },
      paths: stringArraySchema(0, 128), glob: { type: "string", minLength: 1, maxLength: 1_024 },
      fixedStrings: { type: "boolean" }, maxMatchesPerFile: { type: "integer", minimum: 1, maximum: 10_000 },
    }, ["pattern"]),
  }),
  Object.freeze({
    name: "patch_apply", description: "Validate and apply a bounded Git-compatible patch inside the current workspace.",
    inputSchema: objectSchema({ patch: { type: "string", minLength: 1, maxLength: 1024 * 1024 } }, ["patch"]),
  }),
  Object.freeze({
    name: "git_exec", description: "Run an allowlisted local Git subcommand with hooks disabled and network unavailable.",
    inputSchema: objectSchema({ args: stringArraySchema(1, 256) }, ["args"]),
  }),
  Object.freeze({
    name: "test_run", description: "Run a bounded package-manager test script in the isolated workspace.",
    inputSchema: projectTaskSchema("test"),
  }),
  Object.freeze({
    name: "build_run", description: "Run a bounded package-manager build script in the isolated workspace.",
    inputSchema: projectTaskSchema("build"),
  }),
  Object.freeze({
    name: "package_run", description: "Create a package archive with the selected package manager in the isolated workspace.",
    inputSchema: objectSchema({ manager: packageManagerSchema, cwd: workspaceDirectorySchema, args: stringArraySchema(0, 64) }, []),
  }),
]);

const ARTIFACT_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: "artifact_publish", description: "Publish a file from the current owned workspace as a downloadable run artifact.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, mediaType: { type: "string" } },
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
