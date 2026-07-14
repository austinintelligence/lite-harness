import { JsonLineRpcClient, type ProcessSpec } from "@lite-harness/process-rpc";

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpTransport {
  start(): Promise<void>;
  call(tool: string, input: unknown): Promise<unknown>;
  listTools?(): Promise<McpToolDescriptor[]>;
  stop(): Promise<void>;
}

export class StdioMcpTransport implements McpTransport {
  readonly #rpc: JsonLineRpcClient;
  #started = false;

  constructor(spec: ProcessSpec, options: { timeoutMs?: number; maxPayloadBytes?: number } = {}) {
    this.#rpc = new JsonLineRpcClient(spec, {
      requestTimeoutMs: options.timeoutMs ?? 15_000,
      maxLineBytes: options.maxPayloadBytes ?? 1024 * 1024,
      jsonRpcVersion: "2.0",
      onServerRequest: async (request) => {
        if (request.method === "ping") return {};
        throw new Error(`MCP server request is not supported: ${request.method}`);
      },
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const result = await this.#rpc.request<{ protocolVersion?: string }>("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "lite-harness", title: "Lite-Harness", version: "0.1.0-alpha.0" },
    });
    if (!result.protocolVersion || !["2025-11-25", "2025-06-18", "2025-03-26"].includes(result.protocolVersion)) {
      await this.#rpc.stop();
      throw new Error(`MCP protocol version is unsupported: ${result.protocolVersion ?? "missing"}`);
    }
    this.#rpc.notify("notifications/initialized");
    this.#started = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.start();
    const result = await this.#rpc.request<{ tools?: McpToolDescriptor[] }>("tools/list", {});
    return (result.tools ?? []).map((tool) => ({ ...tool }));
  }

  async call(tool: string, input: unknown): Promise<unknown> {
    await this.start();
    return await this.#rpc.request("tools/call", { name: tool, arguments: input });
  }

  async stop(): Promise<void> {
    this.#started = false;
    await this.#rpc.stop();
  }
}

interface McpRegistration {
  factory: () => McpTransport;
  transport?: McpTransport;
  include?: readonly string[];
  exclude?: readonly string[];
  failures: number;
  retryAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class McpSupervisor {
  readonly #registrations = new Map<string, McpRegistration>();

  constructor(private readonly limits: { timeoutMs?: number; maxPayloadBytes?: number; idleTtlMs?: number; maxBackoffMs?: number } = {}) {}

  register(serverId: string, factory: () => McpTransport, policy: { include?: readonly string[]; exclude?: readonly string[] } = {}): void {
    if (this.#registrations.has(serverId)) throw new Error(`MCP server already registered: ${serverId}`);
    this.#registrations.set(serverId, { factory, ...policy, failures: 0, retryAt: 0 });
  }

  isActive(serverId: string): boolean {
    return this.#registrations.get(serverId)?.transport !== undefined;
  }

  async call(serverId: string, tool: string, input: unknown): Promise<unknown> {
    const registration = this.#registrations.get(serverId);
    if (!registration) throw new Error(`MCP server is not registered: ${serverId}`);
    if (!isToolAllowed(tool, registration)) throw new Error(`MCP tool is denied by policy: ${serverId}.${tool}`);
    if (registration.retryAt > Date.now()) throw new Error(`MCP server is in crash backoff: ${serverId}`);
    const inputBytes = Buffer.byteLength(JSON.stringify(input));
    if (inputBytes > (this.limits.maxPayloadBytes ?? 1024 * 1024)) throw new Error("MCP input exceeds the payload limit");
    if (!registration.transport) {
      registration.transport = registration.factory();
      try { await registration.transport.start(); }
      catch (error) { this.#recordFailure(registration); registration.transport = undefined; throw error; }
    }
    try {
      const output = await withTimeout(
        registration.transport.call(tool, input),
        this.limits.timeoutMs ?? 15_000,
      );
      if (Buffer.byteLength(JSON.stringify(output)) > (this.limits.maxPayloadBytes ?? 1024 * 1024)) {
        throw new Error("MCP output exceeds the payload limit");
      }
      registration.failures = 0;
      registration.retryAt = 0;
      this.#armIdle(serverId, registration);
      return output;
    } catch (error) {
      this.#recordFailure(registration);
      await this.stop(serverId);
      throw error;
    }
  }

  async listTools(serverId: string): Promise<McpToolDescriptor[]> {
    const registration = this.#registrations.get(serverId);
    if (!registration) throw new Error(`MCP server is not registered: ${serverId}`);
    if (registration.retryAt > Date.now()) throw new Error(`MCP server is in crash backoff: ${serverId}`);
    if (!registration.transport) {
      registration.transport = registration.factory();
      try { await registration.transport.start(); }
      catch (error) { this.#recordFailure(registration); registration.transport = undefined; throw error; }
    }
    try {
      const tools = await registration.transport.listTools?.() ?? [];
      registration.failures = 0;
      registration.retryAt = 0;
      this.#armIdle(serverId, registration);
      return tools.filter((tool) => isToolAllowed(tool.name, registration));
    } catch (error) {
      this.#recordFailure(registration);
      await this.stop(serverId);
      throw error;
    }
  }

  async stop(serverId: string): Promise<void> {
    const registration = this.#registrations.get(serverId);
    const transport = registration?.transport;
    if (registration) {
      if (registration.idleTimer) clearTimeout(registration.idleTimer);
      registration.idleTimer = undefined;
      registration.transport = undefined;
    }
    if (transport) await transport.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#registrations.keys()].map((id) => this.stop(id)));
  }

  #recordFailure(registration: McpRegistration): void {
    registration.failures += 1;
    registration.retryAt = Date.now() + Math.min(2 ** (registration.failures - 1) * 250, this.limits.maxBackoffMs ?? 30_000);
  }

  #armIdle(serverId: string, registration: McpRegistration): void {
    if (registration.idleTimer) clearTimeout(registration.idleTimer);
    const ttl = this.limits.idleTtlMs ?? 60_000;
    if (ttl <= 0) return;
    registration.idleTimer = setTimeout(() => void this.stop(serverId), ttl);
    registration.idleTimer.unref?.();
  }
}

function isToolAllowed(tool: string, registration: Pick<McpRegistration, "include" | "exclude">): boolean {
  if (registration.exclude?.some((pattern) => matches(pattern, tool))) return false;
  return !registration.include || registration.include.some((pattern) => matches(pattern, tool));
}

function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP call timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
