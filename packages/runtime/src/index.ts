import type { ToolCall, ToolResult } from "@lite-harness/contracts";

export interface ToolRuntime {
  execute(params: {
    workspaceId: string;
    call: ToolCall;
    signal?: AbortSignal;
  }): Promise<ToolResult>;
}

export class InMemoryToolRuntime implements ToolRuntime {
  readonly #workspaces = new Map<string, Map<string, string>>();

  async execute(params: {
    workspaceId: string;
    call: ToolCall;
    signal?: AbortSignal;
  }): Promise<ToolResult> {
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
