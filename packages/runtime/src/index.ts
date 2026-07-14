import type { ArtifactRecord, InternalPrincipal, ToolCall, ToolResult } from "@lite-harness/contracts";

export interface ToolExecutionContext {
  workspaceId: string;
  runId?: string;
  principal?: InternalPrincipal;
  call: ToolCall;
  signal?: AbortSignal;
}

export interface ToolRuntime {
  execute(params: ToolExecutionContext): Promise<ToolResult>;
}

export class InMemoryToolRuntime implements ToolRuntime {
  readonly #workspaces = new Map<string, Map<string, string>>();

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
