import { JsonLineRpcClient, type ProcessSpec } from "@lite-harness/process-rpc";
import { join } from "node:path";

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpTransport {
  start(signal?: AbortSignal): Promise<void>;
  call(tool: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  listTools?(signal?: AbortSignal): Promise<McpToolDescriptor[]>;
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

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) return;
    const result = await this.#rpc.request<{ protocolVersion?: string }>("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "lite-harness", title: "Lite-Harness", version: "0.1.0-alpha.0" },
    }, { signal });
    if (!result.protocolVersion || !["2025-11-25", "2025-06-18", "2025-03-26"].includes(result.protocolVersion)) {
      await this.#rpc.stop();
      throw new Error(`MCP protocol version is unsupported: ${result.protocolVersion ?? "missing"}`);
    }
    this.#rpc.notify("notifications/initialized");
    this.#started = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    await this.start(signal);
    const result = await this.#rpc.request<{ tools?: McpToolDescriptor[] }>("tools/list", {}, { signal });
    return validateMcpToolDescriptors(result.tools ?? []);
  }

  async call(tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal);
    return await this.#rpc.request("tools/call", { name: tool, arguments: input }, { signal });
  }

  async stop(): Promise<void> {
    this.#started = false;
    await this.#rpc.stop();
  }
}

export class DockerStdioMcpTransport extends StdioMcpTransport {
  constructor(options: {
    image: string;
    command: string;
    args?: readonly string[];
    dockerCommand?: string;
    seccompProfile?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
    timeoutMs?: number;
    maxPayloadBytes?: number;
  }) {
    super(createDockerMcpProcessSpec(options), { timeoutMs: options.timeoutMs, maxPayloadBytes: options.maxPayloadBytes });
  }
}

export function createDockerMcpProcessSpec(options: {
  image: string;
  command: string;
  args?: readonly string[];
  dockerCommand?: string;
  seccompProfile?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
}): ProcessSpec {
  if (!options.image.includes("@sha256:") && !/^sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error("MCP image must be pinned by sha256 digest");
  if (!options.command || options.command.length > 4096 || /[\0\r\n]/.test(options.command)) throw new Error("MCP container command is invalid");
  const args = options.args ?? [];
  if (args.length > 256 || args.some((arg) => arg.length > 4096 || /\0/.test(arg))) throw new Error("MCP container arguments are invalid");
  return {
    command: options.dockerCommand ?? "docker",
    args: [
      "run", "--rm", "--interactive", "--init", "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--security-opt", `seccomp=${options.seccompProfile ?? join(process.cwd(), "docker", "browser-runtime", "seccomp_profile.json")}`,
      "--user", "1000:1000", "--pids-limit", String(options.pidsLimit ?? 64),
      "--memory", options.memory ?? "256m", "--cpus", options.cpus ?? "1",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      options.image, options.command, ...args,
    ],
  };
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

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) return;
    const result = await this.#request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "lite-harness", title: "Lite-Harness", version: "0.1.0-alpha.0" },
    }, signal) as { protocolVersion?: string };
    if (!result.protocolVersion || !["2025-11-25", "2025-06-18", "2025-03-26"].includes(result.protocolVersion)) {
      throw new Error(`MCP protocol version is unsupported: ${result.protocolVersion ?? "missing"}`);
    }
    await this.#notify("notifications/initialized", signal);
    this.#started = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    await this.start(signal);
    const result = await this.#request("tools/list", {}, signal) as { tools?: McpToolDescriptor[] };
    return validateMcpToolDescriptors(result.tools ?? []);
  }

  async call(tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal);
    return await this.#request("tools/call", { name: tool, arguments: input }, signal);
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

  async #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#send({ jsonrpc: "2.0", id, method, params }, signal);
    if (!response || typeof response !== "object" || (response as { id?: unknown }).id !== id) throw new Error("MCP response id did not match the request");
    const message = response as { result?: unknown; error?: { code?: number; message?: string } };
    if (message.error) throw new Error(`MCP ${method} failed: ${message.error.message ?? message.error.code ?? "unknown"}`);
    return message.result;
  }

  async #notify(method: string, signal?: AbortSignal): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method }, signal);
  }

  async #send(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > this.maxPayloadBytes) throw new Error("MCP request exceeds the payload limit");
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await this.#fetch(this.#url, {
      method: "POST", redirect: "manual", headers: await this.#headers(this.#sessionId), body: encoded,
      signal: requestSignal,
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
  policy: BrokeredMcpToolPolicy;
}

/** One policy object gates advertised schemas and every brokered MCP call. */
export class BrokeredMcpToolPolicy {
  constructor(private readonly options: {
    include?: readonly string[];
    exclude?: readonly string[];
    maxPayloadBytes?: number;
    maxTools?: number;
  } = {}) {}

  assertCall(tool: string, input: unknown): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(tool)) throw new Error("MCP tool name is invalid");
    if (!this.allows(tool)) throw new Error(`MCP tool is denied by policy: ${tool}`);
    if (encodedBytes(input) > (this.options.maxPayloadBytes ?? 1024 * 1024)) throw new Error("MCP input exceeds the payload limit");
  }

  assertOutput(output: unknown): void {
    if (encodedBytes(output) > (this.options.maxPayloadBytes ?? 1024 * 1024)) throw new Error("MCP output exceeds the payload limit");
  }

  filterTools(tools: unknown): McpToolDescriptor[] {
    const validated = validateMcpToolDescriptors(tools, this.options.maxTools ?? 256, this.options.maxPayloadBytes ?? 1024 * 1024);
    return validated.filter((tool) => this.allows(tool.name));
  }

  allows(tool: string): boolean {
    if (this.options.exclude?.some((pattern) => matches(pattern, tool))) return false;
    return !this.options.include || this.options.include.some((pattern) => matches(pattern, tool));
  }
}

export class McpSupervisor {
  readonly #registrations = new Map<string, McpRegistration>();

  constructor(private readonly limits: { timeoutMs?: number; maxPayloadBytes?: number; idleTtlMs?: number; maxBackoffMs?: number } = {}) {}

  register(serverId: string, factory: () => McpTransport, policy: { include?: readonly string[]; exclude?: readonly string[] } = {}): void {
    if (this.#registrations.has(serverId)) throw new Error(`MCP server already registered: ${serverId}`);
    this.#registrations.set(serverId, {
      factory, ...policy, failures: 0, retryAt: 0,
      policy: new BrokeredMcpToolPolicy({ ...policy, maxPayloadBytes: this.limits.maxPayloadBytes }),
    });
  }

  isActive(serverId: string): boolean {
    return this.#registrations.get(serverId)?.transport !== undefined;
  }

  async call(serverId: string, tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const registration = this.#registrations.get(serverId);
    if (!registration) throw new Error(`MCP server is not registered: ${serverId}`);
    registration.policy.assertCall(tool, input);
    if (registration.retryAt > Date.now()) throw new Error(`MCP server is in crash backoff: ${serverId}`);
    if (!registration.transport) {
      registration.transport = registration.factory();
      try { await withTimeout(registration.transport.start(signal), this.limits.timeoutMs ?? 15_000, signal); }
      catch (error) {
        const failed = registration.transport;
        this.#recordFailure(registration); registration.transport = undefined;
        await failed.stop().catch(() => undefined);
        throw error;
      }
    }
    try {
      const output = await withTimeout(
        registration.transport.call(tool, input, signal),
        this.limits.timeoutMs ?? 15_000,
        signal,
      );
      registration.policy.assertOutput(output);
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

  async listTools(serverId: string, signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const registration = this.#registrations.get(serverId);
    if (!registration) throw new Error(`MCP server is not registered: ${serverId}`);
    if (registration.retryAt > Date.now()) throw new Error(`MCP server is in crash backoff: ${serverId}`);
    if (!registration.transport) {
      registration.transport = registration.factory();
      try { await withTimeout(registration.transport.start(signal), this.limits.timeoutMs ?? 15_000, signal); }
      catch (error) {
        const failed = registration.transport;
        this.#recordFailure(registration); registration.transport = undefined;
        await failed.stop().catch(() => undefined);
        throw error;
      }
    }
    try {
      const tools = registration.policy.filterTools(await withTimeout(
        registration.transport.listTools?.(signal) ?? Promise.resolve([]),
        this.limits.timeoutMs ?? 15_000,
        signal,
      ));
      registration.failures = 0;
      registration.retryAt = 0;
      this.#armIdle(serverId, registration);
      return tools;
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

function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal?.reason ?? new Error("MCP call was aborted")));
    const timer = setTimeout(() => finish(() => reject(new Error(`MCP call timed out after ${timeoutMs}ms`))), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function validateMcpToolDescriptors(value: unknown, maxTools = 256, maxBytes = 1024 * 1024): McpToolDescriptor[] {
  if (!Array.isArray(value) || value.length > maxTools) throw new Error("MCP tool list is invalid or too large");
  const seen = new Set<string>();
  const tools = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP tool descriptor is invalid");
    const descriptor = item as Record<string, unknown>;
    if (typeof descriptor.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(descriptor.name) || seen.has(descriptor.name)) {
      throw new Error("MCP tool descriptor name is invalid or duplicated");
    }
    if (descriptor.description !== undefined && (typeof descriptor.description !== "string" || descriptor.description.length > 4096)) {
      throw new Error("MCP tool description is invalid");
    }
    if (!descriptor.inputSchema || typeof descriptor.inputSchema !== "object" || Array.isArray(descriptor.inputSchema)) {
      throw new Error("MCP tool input schema is invalid");
    }
    if (encodedBytes(descriptor.inputSchema) > maxBytes) throw new Error("MCP tool input schema exceeds the payload limit");
    seen.add(descriptor.name);
    return {
      name: descriptor.name,
      ...(typeof descriptor.description === "string" ? { description: descriptor.description } : {}),
      inputSchema: structuredClone(descriptor.inputSchema),
    };
  });
  return tools;
}

function encodedBytes(value: unknown): number {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("MCP payload is not JSON serializable"); }
  if (encoded === undefined) throw new Error("MCP payload is not JSON serializable");
  return Buffer.byteLength(encoded);
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
