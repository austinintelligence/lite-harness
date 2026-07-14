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

export class StreamableHttpMcpTransport implements McpTransport {
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  #sessionId?: string;
  #started = false;
  #nextId = 1;

  constructor(options: {
    url: string;
    allowedOrigins: readonly string[];
    authorization?: () => Promise<string | undefined>;
    fetch?: typeof globalThis.fetch;
    maxPayloadBytes?: number;
    timeoutMs?: number;
  }) {
    this.#url = new URL(options.url);
    if (this.#url.username || this.#url.password) throw new Error("MCP URL must not contain credentials");
    if (!options.allowedOrigins.includes(this.#url.origin)) throw new Error(`MCP origin is not allowlisted: ${this.#url.origin}`);
    if (this.#url.protocol !== "https:" && !(this.#url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(this.#url.hostname))) {
      throw new Error("Remote MCP requires HTTPS or a loopback-local HTTP endpoint");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.authorization = options.authorization;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private readonly authorization?: () => Promise<string | undefined>;
  private readonly maxPayloadBytes: number;
  private readonly timeoutMs: number;

  async start(): Promise<void> {
    if (this.#started) return;
    const result = await this.#request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "lite-harness", title: "Lite-Harness", version: "0.1.0-alpha.0" },
    }) as { protocolVersion?: string };
    if (!result.protocolVersion || !["2025-11-25", "2025-06-18", "2025-03-26"].includes(result.protocolVersion)) {
      throw new Error(`MCP protocol version is unsupported: ${result.protocolVersion ?? "missing"}`);
    }
    await this.#notify("notifications/initialized");
    this.#started = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.start();
    const result = await this.#request("tools/list", {}) as { tools?: McpToolDescriptor[] };
    return (result.tools ?? []).map((tool) => ({ ...tool }));
  }

  async call(tool: string, input: unknown): Promise<unknown> {
    await this.start();
    return await this.#request("tools/call", { name: tool, arguments: input });
  }

  async stop(): Promise<void> {
    const sessionId = this.#sessionId;
    this.#sessionId = undefined; this.#started = false;
    if (!sessionId) return;
    const response = await this.#fetch(this.#url, {
      method: "DELETE", headers: await this.#headers(sessionId), redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok && response.status !== 404 && response.status !== 405) throw new Error(`MCP session termination failed with HTTP ${response.status}`);
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#send({ jsonrpc: "2.0", id, method, params });
    if (!response || typeof response !== "object" || (response as { id?: unknown }).id !== id) throw new Error("MCP response id did not match the request");
    const message = response as { result?: unknown; error?: { code?: number; message?: string } };
    if (message.error) throw new Error(`MCP ${method} failed: ${message.error.message ?? message.error.code ?? "unknown"}`);
    return message.result;
  }

  async #notify(method: string): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method });
  }

  async #send(payload: unknown): Promise<unknown> {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > this.maxPayloadBytes) throw new Error("MCP request exceeds the payload limit");
    const response = await this.#fetch(this.#url, {
      method: "POST", redirect: "manual", headers: await this.#headers(this.#sessionId), body: encoded,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("MCP redirects are denied");
    if (!response.ok) throw new Error(`MCP HTTP transport returned ${response.status}`);
    const session = response.headers.get("mcp-session-id");
    if (session) this.#sessionId = session;
    if (response.status === 202 || !response.body) return {};
    const contentType = response.headers.get("content-type") ?? "";
    const text = await boundedText(response, this.maxPayloadBytes);
    if (contentType.includes("text/event-stream")) {
      const data = text.replaceAll("\r\n", "\n").split("\n\n").flatMap((frame) =>
        frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()),
      ).filter(Boolean);
      const requestId = (payload as { id?: unknown }).id;
      for (const item of data) {
        const message = JSON.parse(item) as { id?: unknown; method?: string };
        if (requestId !== undefined && message.id === requestId) return message;
        if (message.method) throw new Error(`MCP server-initiated request is unsupported over HTTP: ${message.method}`);
      }
      if (requestId === undefined) return {};
      throw new Error("MCP SSE response contained no matching response event");
    }
    try { return text ? JSON.parse(text) : {}; }
    catch { throw new Error("MCP HTTP response was not valid JSON"); }
  }

  async #headers(sessionId?: string): Promise<Record<string, string>> {
    const authorization = await this.authorization?.();
    return {
      accept: "application/json, text/event-stream", "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(authorization ? { authorization } : {}),
    };
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
    registration.idleTimer = setTimeout(() => { void this.stop(serverId).catch(() => undefined); }, ttl);
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

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error("MCP response exceeds the payload limit");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
