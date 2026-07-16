import { JsonLineRpcClient, type ProcessSpec } from "@lite-harness/process-rpc";
import { killAndReapContainer, type DockerCommandResult, type DockerCommandRunner } from "@lite-harness/runtime-docker";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isLoopbackHostname } from "@lite-harness/contracts";

const addFormats = addFormatsImport as unknown as FormatsPlugin;
const mcpSchemaMetaValidator = new Ajv2020({ allErrors: false, strict: true });

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
  #startPromise?: Promise<void>;
  #lifecycleController = new AbortController();

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
    if (this.#startPromise) return await this.#startPromise;
    const operation = this.#start(signal);
    this.#startPromise = operation;
    try { await operation; }
    finally { if (this.#startPromise === operation) this.#startPromise = undefined; }
  }

  async #start(signal?: AbortSignal): Promise<void> {
    const lifecycleSignal = signal
      ? AbortSignal.any([signal, this.#lifecycleController.signal])
      : this.#lifecycleController.signal;
    const result = await this.#rpc.request<{ protocolVersion?: string }>("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "lite-harness", title: "Lite-Harness", version: "0.1.0-alpha.0" },
    }, { signal: lifecycleSignal });
    if (!result.protocolVersion || !["2025-11-25", "2025-06-18", "2025-03-26"].includes(result.protocolVersion)) {
      await this.#rpc.stop();
      throw new Error(`MCP protocol version is unsupported: ${result.protocolVersion ?? "missing"}`);
    }
    lifecycleSignal.throwIfAborted();
    this.#rpc.notify("notifications/initialized");
    this.#started = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    await this.start(signal);
    const operationSignal = signal
      ? AbortSignal.any([signal, this.#lifecycleController.signal])
      : this.#lifecycleController.signal;
    const result = await this.#rpc.request<{ tools?: McpToolDescriptor[] }>("tools/list", {}, { signal: operationSignal });
    return validateMcpToolDescriptors(result.tools ?? []);
  }

  async call(tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal);
    const operationSignal = signal
      ? AbortSignal.any([signal, this.#lifecycleController.signal])
      : this.#lifecycleController.signal;
    return await this.#rpc.request("tools/call", { name: tool, arguments: input }, { signal: operationSignal });
  }

  async stop(): Promise<void> {
    this.#lifecycleController.abort(new Error("MCP stdio transport stopped"));
    this.#started = false;
    const starting = this.#startPromise;
    try {
      await this.#rpc.stop();
      await starting?.catch(() => undefined);
    }
    finally { this.#lifecycleController = new AbortController(); }
  }
}

export class DockerStdioMcpTransport extends StdioMcpTransport {
  readonly #containerName: string;
  readonly #cleanupRunner: DockerCommandRunner;
  #stopPromise?: Promise<void>;

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
    containerName?: string;
    installationId?: string;
    cleanupRunner?: DockerCommandRunner;
  }) {
    const containerName = options.containerName ?? managedMcpContainerName();
    super(createDockerMcpProcessSpec({ ...options, containerName }), { timeoutMs: options.timeoutMs, maxPayloadBytes: options.maxPayloadBytes });
    const dockerCommand = options.dockerCommand ?? "docker";
    this.#containerName = containerName;
    this.#cleanupRunner = options.cleanupRunner ?? ((args) => runDockerCleanupCommand(dockerCommand, args));
  }

  override async stop(): Promise<void> {
    if (this.#stopPromise) return await this.#stopPromise;
    const operation = this.#stopAndReap();
    this.#stopPromise = operation;
    try { await operation; }
    finally { if (this.#stopPromise === operation) this.#stopPromise = undefined; }
  }

  async #stopAndReap(): Promise<void> {
    const failures: unknown[] = [];
    try { await super.stop(); } catch (error) { failures.push(error); }
    try { await killAndReapContainer(this.#cleanupRunner, this.#containerName); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "MCP Docker process and container cleanup failed");
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
  containerName?: string;
  installationId?: string;
}): ProcessSpec {
  if (!options.image.includes("@sha256:") && !/^sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error("MCP image must be pinned by sha256 digest");
  if (!options.command || options.command.length > 4096 || /[\0\r\n]/.test(options.command)) throw new Error("MCP container command is invalid");
  const args = options.args ?? [];
  if (args.length > 256 || args.some((arg) => arg.length > 4096 || /\0/.test(arg))) throw new Error("MCP container arguments are invalid");
  const containerName = options.containerName ?? managedMcpContainerName();
  if (!/^lite-harness-mcp-[a-z0-9][a-z0-9_.-]{0,96}$/.test(containerName)) throw new Error("MCP container name is invalid");
  if (options.installationId !== undefined && !options.installationId.trim()) throw new Error("MCP installation identity is invalid");
  return {
    command: options.dockerCommand ?? "docker",
    args: [
      "run", "--pull=never", "--interactive", "--init", "--name", containerName,
      "--label", "lite-harness.managed=true", "--label", "lite-harness.component=mcp",
      ...(options.installationId ? ["--label", `lite-harness.installation=${digestLabel(options.installationId)}`] : []),
      "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--security-opt", `seccomp=${options.seccompProfile ?? join(process.cwd(), "docker", "browser-runtime", "seccomp_profile.json")}`,
      "--user", "1000:1000", "--pids-limit", String(options.pidsLimit ?? 64),
      "--memory", options.memory ?? "256m", "--cpus", options.cpus ?? "1",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      options.image, options.command, ...args,
    ],
  };
}

function digestLabel(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function managedMcpContainerName(): string {
  return `lite-harness-mcp-${randomUUID().replaceAll("-", "")}`;
}

function runDockerCleanupCommand(command: string, args: readonly string[]): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBytes = 64 * 1024;
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("MCP Docker cleanup output exceeded 64 KiB")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    })));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("MCP Docker cleanup timed out after 15000ms")));
    }, 15_000);
    timer.unref?.();
  });
}

export class StreamableHttpMcpTransport implements McpTransport {
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  #sessionId?: string;
  #started = false;
  #startPromise?: Promise<void>;
  #lifecycleController = new AbortController();
  readonly #inFlight = new Set<Promise<unknown>>();
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
    if (this.#url.protocol !== "https:" && !(this.#url.protocol === "http:" && isLoopbackHostname(this.#url.hostname))) {
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
    if (this.#startPromise) return await this.#startPromise;
    const operation = this.#start(signal);
    this.#startPromise = operation;
    try { await operation; }
    finally { if (this.#startPromise === operation) this.#startPromise = undefined; }
  }

  async #start(signal?: AbortSignal): Promise<void> {
    const lifecycleSignal = signal
      ? AbortSignal.any([signal, this.#lifecycleController.signal])
      : this.#lifecycleController.signal;
    const result = await this.#request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "lite-harness", title: "Lite-Harness", version: "0.1.0-alpha.0" },
    }, lifecycleSignal) as { protocolVersion?: string };
    if (!result.protocolVersion || !["2025-11-25", "2025-06-18", "2025-03-26"].includes(result.protocolVersion)) {
      throw new Error(`MCP protocol version is unsupported: ${result.protocolVersion ?? "missing"}`);
    }
    await this.#notify("notifications/initialized", lifecycleSignal);
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
    this.#lifecycleController.abort(new Error("MCP HTTP transport stopped"));
    await Promise.allSettled([...this.#inFlight]);
    await this.#startPromise?.catch(() => undefined);
    const sessionId = this.#sessionId;
    this.#sessionId = undefined; this.#started = false;
    this.#lifecycleController = new AbortController();
    if (sessionId) {
      const response = await this.#fetch(this.#url, {
        method: "DELETE", headers: await this.#headers(sessionId), redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok && response.status !== 404 && response.status !== 405) throw new Error(`MCP session termination failed with HTTP ${response.status}`);
    }
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
    const operation = this.#sendOnce(payload, signal);
    this.#inFlight.add(operation);
    try { return await operation; }
    finally { this.#inFlight.delete(operation); }
  }

  async #sendOnce(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > this.maxPayloadBytes) throw new Error("MCP request exceeds the payload limit");
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const requestController = new AbortController();
    const requestSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      this.#lifecycleController.signal,
      deadline,
      requestController.signal,
    ]);
    let response: Response | undefined;
    try {
      const headers = await withTimeout(this.#headers(this.#sessionId), this.timeoutMs, requestSignal);
      requestSignal.throwIfAborted();
      response = await this.#fetch(this.#url, {
        method: "POST", redirect: "manual", headers, body: encoded,
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      if (response.status >= 300 && response.status < 400) throw new Error("MCP redirects are denied");
      if (!response.ok) throw new Error(`MCP HTTP transport returned ${response.status}`);
      const session = response.headers.get("mcp-session-id");
      if (session) this.#sessionId = session;
      if (response.status === 202 || !response.body) return {};
      const contentType = response.headers.get("content-type") ?? "";
      const text = await boundedText(response, this.maxPayloadBytes);
      requestSignal.throwIfAborted();
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
    } catch (error) {
      requestController.abort(error);
      if (response?.body && !response.body.locked) await response.body.cancel(error).catch(() => undefined);
      throw error;
    }
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
  expectedTools?: readonly McpToolDescriptor[];
  catalogValidated: boolean;
  startPromise?: Promise<void>;
  catalogPromise?: Promise<McpToolDescriptor[]>;
  stopPromise?: Promise<void>;
  activeOperations: number;
  generation: number;
}

interface McpTransportLease {
  transport: McpTransport;
  generation: number;
  startPromise?: Promise<void>;
}

export interface McpRegistrationPolicy {
  include?: readonly string[];
  exclude?: readonly string[];
  expectedTools?: readonly McpToolDescriptor[];
}

/** One policy object gates advertised schemas and every brokered MCP call. */
export class BrokeredMcpToolPolicy {
  constructor(private readonly options: {
    include?: readonly string[];
    exclude?: readonly string[];
    maxPayloadBytes?: number;
    maxTools?: number;
    compileSchemas?: boolean;
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
    const validated = validateMcpToolDescriptors(
      tools,
      this.options.maxTools ?? 256,
      this.options.maxPayloadBytes ?? 1024 * 1024,
      this.options.compileSchemas ?? false,
    );
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

  register(serverId: string, factory: () => McpTransport, policy: McpRegistrationPolicy = {}): void {
    if (this.#registrations.has(serverId)) throw new Error(`MCP server already registered: ${serverId}`);
    const toolPolicy = new BrokeredMcpToolPolicy({
      include: policy.include, exclude: policy.exclude, maxPayloadBytes: this.limits.maxPayloadBytes,
    });
    const expectedTools = policy.expectedTools
      ? new BrokeredMcpToolPolicy({
          include: policy.include, exclude: policy.exclude, maxPayloadBytes: this.limits.maxPayloadBytes, compileSchemas: true,
        }).filterTools(policy.expectedTools)
      : undefined;
    this.#registrations.set(serverId, {
      factory, include: policy.include, exclude: policy.exclude, failures: 0, retryAt: 0, catalogValidated: false,
      activeOperations: 0, generation: 0,
      policy: toolPolicy,
      ...(expectedTools ? { expectedTools } : {}),
    });
  }

  isActive(serverId: string): boolean {
    return this.#registrations.get(serverId)?.transport !== undefined;
  }

  async call(serverId: string, tool: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const registration = this.#registrations.get(serverId);
    if (!registration) throw new Error(`MCP server is not registered: ${serverId}`);
    registration.policy.assertCall(tool, input);
    if (registration.expectedTools && !registration.expectedTools.some((descriptor) => descriptor.name === tool)) {
      throw new Error(`MCP tool is denied by the configured catalog: ${tool}`);
    }
    if (registration.retryAt > Date.now()) throw new Error(`MCP server is in crash backoff: ${serverId}`);
    signal?.throwIfAborted();
    this.#beginOperation(registration);
    let lease: McpTransportLease | undefined;
    try {
      lease = await this.#acquireTransport(registration, signal);
      await this.#awaitStarted(registration, lease, signal);
      if (registration.expectedTools && !registration.catalogValidated) {
        await this.#ensureExpectedCatalog(registration, lease, signal);
      }
      const output = await withTimeout(
        lease.transport.call(tool, input, signal),
        this.limits.timeoutMs ?? 15_000,
        signal,
      );
      if (!this.#isCurrent(registration, lease)) throw new Error(`MCP server became unavailable: ${serverId}`);
      registration.policy.assertOutput(output);
      registration.failures = 0;
      registration.retryAt = 0;
      return output;
    } catch (error) {
      if (signal?.aborted) {
        if (lease && this.#isCurrent(registration, lease) && registration.activeOperations === 1) {
          try { await this.#stopRegistration(registration, lease); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "MCP cancellation and cleanup both failed"); }
        }
      } else if (lease && this.#isCurrent(registration, lease)) {
        this.#recordFailure(registration);
        try { await this.#stopRegistration(registration, lease); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "MCP call and cleanup both failed"); }
      } else if (!lease && !registration.transport && !registration.stopPromise) {
        this.#recordFailure(registration);
      }
      throw error;
    } finally {
      this.#endOperation(serverId, registration);
    }
  }

  async listTools(serverId: string, signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const registration = this.#registrations.get(serverId);
    if (!registration) throw new Error(`MCP server is not registered: ${serverId}`);
    if (registration.retryAt > Date.now()) throw new Error(`MCP server is in crash backoff: ${serverId}`);
    signal?.throwIfAborted();
    this.#beginOperation(registration);
    let lease: McpTransportLease | undefined;
    try {
      lease = await this.#acquireTransport(registration, signal);
      await this.#awaitStarted(registration, lease, signal);
      const tools = registration.expectedTools
        ? await this.#ensureExpectedCatalog(registration, lease, signal)
        : await this.#readAndValidateCatalog(registration, lease, signal);
      if (!this.#isCurrent(registration, lease)) throw new Error(`MCP server became unavailable: ${serverId}`);
      registration.failures = 0;
      registration.retryAt = 0;
      return tools;
    } catch (error) {
      if (signal?.aborted) {
        if (lease && this.#isCurrent(registration, lease) && registration.activeOperations === 1) {
          try { await this.#stopRegistration(registration, lease); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "MCP catalog cancellation and cleanup both failed"); }
        }
      } else if (lease && this.#isCurrent(registration, lease)) {
        this.#recordFailure(registration);
        try { await this.#stopRegistration(registration, lease); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "MCP catalog and cleanup both failed"); }
      } else if (!lease && !registration.transport && !registration.stopPromise) {
        this.#recordFailure(registration);
      }
      throw error;
    } finally {
      this.#endOperation(serverId, registration);
    }
  }

  async stop(serverId: string): Promise<void> {
    const registration = this.#registrations.get(serverId);
    if (!registration) return;
    await this.#stopRegistration(registration);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#registrations.keys()].map((id) => this.stop(id)));
  }

  #recordFailure(registration: McpRegistration): void {
    registration.failures += 1;
    registration.retryAt = Date.now() + Math.min(2 ** (registration.failures - 1) * 250, this.limits.maxBackoffMs ?? 30_000);
  }

  async #acquireTransport(registration: McpRegistration, signal?: AbortSignal): Promise<McpTransportLease> {
    if (registration.stopPromise) await withAbortSignal(registration.stopPromise, signal);
    if (!registration.transport) {
      const transport = registration.factory();
      registration.transport = transport;
      registration.generation += 1;
      registration.startPromise = withTimeout(
        transport.start(), this.limits.timeoutMs ?? 15_000,
      );
    }
    return {
      transport: registration.transport,
      generation: registration.generation,
      ...(registration.startPromise ? { startPromise: registration.startPromise } : {}),
    };
  }

  async #awaitStarted(registration: McpRegistration, lease: McpTransportLease, signal?: AbortSignal): Promise<void> {
    const operation = lease.startPromise;
    if (!operation) return;
    await withAbortSignal(operation, signal);
    if (!this.#isCurrent(registration, lease)) throw new Error("MCP server became unavailable during startup");
  }

  async #ensureExpectedCatalog(
    registration: McpRegistration,
    lease: McpTransportLease,
    signal?: AbortSignal,
  ): Promise<McpToolDescriptor[]> {
    if (!this.#isCurrent(registration, lease)) throw new Error("MCP server became unavailable before catalog validation");
    if (registration.catalogValidated) return [...(registration.expectedTools ?? [])];
    const operation = registration.catalogPromise ?? this.#readAndValidateCatalog(registration, lease);
    registration.catalogPromise = operation;
    return await withAbortSignal(operation, signal);
  }

  async #readAndValidateCatalog(
    registration: McpRegistration,
    lease: McpTransportLease,
    signal?: AbortSignal,
  ): Promise<McpToolDescriptor[]> {
    if (!lease.transport.listTools) throw new Error("MCP server did not provide a tool catalog");
    const discovered = registration.policy.filterTools(await withTimeout(
      lease.transport.listTools(signal),
      this.limits.timeoutMs ?? 15_000,
      signal,
    ));
    if (!this.#isCurrent(registration, lease)) throw new Error("MCP server became unavailable during catalog validation");
    const expected = registration.expectedTools;
    if (!expected) return discovered;
    for (const descriptor of expected) {
      const actual = discovered.find((candidate) => candidate.name === descriptor.name);
      if (!actual || !isDeepStrictEqual(actual.inputSchema, descriptor.inputSchema)) {
        throw new Error(`MCP server catalog did not match the configured schema: ${descriptor.name}`);
      }
    }
    registration.catalogValidated = true;
    const expectedNames = new Set(expected.map((descriptor) => descriptor.name));
    return discovered.filter((descriptor) => expectedNames.has(descriptor.name));
  }

  #beginOperation(registration: McpRegistration): void {
    if (registration.idleTimer) clearTimeout(registration.idleTimer);
    registration.idleTimer = undefined;
    registration.activeOperations += 1;
  }

  #endOperation(serverId: string, registration: McpRegistration): void {
    registration.activeOperations = Math.max(0, registration.activeOperations - 1);
    if (registration.activeOperations === 0) this.#armIdle(serverId, registration);
  }

  #armIdle(serverId: string, registration: McpRegistration): void {
    if (registration.activeOperations !== 0 || !registration.transport || registration.stopPromise) return;
    if (registration.idleTimer) clearTimeout(registration.idleTimer);
    const ttl = this.limits.idleTtlMs ?? 60_000;
    if (ttl <= 0) return;
    const lease = { transport: registration.transport, generation: registration.generation };
    const timer = setTimeout(() => {
      if (registration.idleTimer !== timer) return;
      registration.idleTimer = undefined;
      if (registration.activeOperations !== 0 || !this.#isCurrent(registration, lease)) return;
      void this.#stopRegistration(registration, lease).catch(() => undefined);
    }, ttl);
    registration.idleTimer = timer;
    timer.unref?.();
  }

  #isCurrent(registration: McpRegistration, lease: McpTransportLease): boolean {
    return registration.transport === lease.transport && registration.generation === lease.generation;
  }

  async #stopRegistration(registration: McpRegistration, expected?: McpTransportLease): Promise<void> {
    if (expected && !this.#isCurrent(registration, expected)) return;
    if (registration.stopPromise) return await registration.stopPromise;
    const transport = registration.transport;
    if (registration.idleTimer) clearTimeout(registration.idleTimer);
    registration.idleTimer = undefined;
    if (!transport) return;
    registration.transport = undefined;
    registration.generation += 1;
    registration.catalogValidated = false;
    registration.startPromise = undefined;
    registration.catalogPromise = undefined;
    const operation = Promise.resolve().then(() => transport.stop());
    registration.stopPromise = operation;
    try { await operation; }
    finally { if (registration.stopPromise === operation) registration.stopPromise = undefined; }
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

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal.reason ?? new Error("MCP call was aborted")));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function validateMcpToolDescriptors(
  value: unknown,
  maxTools = 256,
  maxBytes = 1024 * 1024,
  compileSchemas = false,
): McpToolDescriptor[] {
  if (!Array.isArray(value) || value.length > maxTools) throw new Error("MCP tool list is invalid or too large");
  const seen = new Set<string>();
  const compiler = compileSchemas ? new Ajv2020({ allErrors: false, strict: true }) : undefined;
  if (compiler) addFormats(compiler);
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
    validateMcpJsonSchemaStructure(descriptor.inputSchema as Record<string, unknown>);
    try {
      if (!mcpSchemaMetaValidator.validateSchema(descriptor.inputSchema)) {
        throw new Error("MCP tool input schema is not a valid JSON Schema");
      }
    } catch {
      throw new Error("MCP tool input schema is not a valid JSON Schema");
    }
    if (compiler) {
      try { compiler.compile(descriptor.inputSchema); }
      catch { throw new Error("MCP tool input schema is not a valid JSON Schema"); }
    }
    seen.add(descriptor.name);
    return {
      name: descriptor.name,
      ...(typeof descriptor.description === "string" ? { description: descriptor.description } : {}),
      inputSchema: structuredClone(descriptor.inputSchema),
    };
  });
  return tools;
}

function validateMcpJsonSchemaStructure(root: Record<string, unknown>): void {
  const values: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let keys = 0;
  while (values.length) {
    const { value, depth } = values.pop()!;
    nodes += 1;
    if (nodes > 4096 || depth > 64) throw new Error("MCP tool input schema exceeds structural complexity limits");
    if (typeof value === "string" && Buffer.byteLength(value) > 65_536) {
      throw new Error("MCP tool input schema exceeds structural complexity limits");
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (value.length > 1024) throw new Error("MCP tool input schema exceeds structural complexity limits");
      for (const item of value) values.push({ value: item, depth: depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("MCP tool input schema must contain only JSON objects");
    const entries = Object.entries(value);
    keys += entries.length;
    if (entries.length > 256 || keys > 8192) throw new Error("MCP tool input schema exceeds structural complexity limits");
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key) > 1024) throw new Error("MCP tool input schema exceeds structural complexity limits");
      values.push({ value: item, depth: depth + 1 });
    }
  }

  const allowedTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  const schemas: Array<{ schema: unknown; depth: number }> = [{ schema: root, depth: 0 }];
  const singleSchemaKeywords = [
    "additionalProperties", "unevaluatedProperties", "items", "contains", "propertyNames", "not", "if", "then", "else",
    "unevaluatedItems", "contentSchema",
  ];
  const arraySchemaKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"];
  const mapSchemaKeywords = ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"];
  while (schemas.length) {
    const { schema, depth } = schemas.pop()!;
    if (depth > 32) throw new Error("MCP tool input schema exceeds structural complexity limits");
    if (schema === true || schema === false) continue;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("MCP tool input schema is not a valid JSON Schema");
    const record = schema as Record<string, unknown>;
    if (record.type !== undefined) {
      const types = typeof record.type === "string" ? [record.type] : record.type;
      if (!Array.isArray(types) || !types.length || types.length > allowedTypes.size ||
          types.some((type) => typeof type !== "string" || !allowedTypes.has(type)) || new Set(types).size !== types.length) {
        throw new Error("MCP tool input schema is not a valid JSON Schema");
      }
    }
    if (record.$ref !== undefined && (typeof record.$ref !== "string" || !record.$ref.startsWith("#") || record.$ref.length > 4096)) {
      throw new Error("MCP tool input schema contains an unsupported reference");
    }
    if (record.required !== undefined && (!Array.isArray(record.required) || record.required.length > 256 ||
        record.required.some((item) => typeof item !== "string") || new Set(record.required).size !== record.required.length)) {
      throw new Error("MCP tool input schema is not a valid JSON Schema");
    }
    if (record.enum !== undefined && (!Array.isArray(record.enum) || !record.enum.length || record.enum.length > 1024)) {
      throw new Error("MCP tool input schema is not a valid JSON Schema");
    }
    for (const keyword of singleSchemaKeywords) {
      const child = record[keyword];
      if (child !== undefined) schemas.push({ schema: child, depth: depth + 1 });
    }
    for (const keyword of arraySchemaKeywords) {
      const children = record[keyword];
      if (children === undefined) continue;
      if (!Array.isArray(children) || !children.length || children.length > 256) throw new Error("MCP tool input schema is not a valid JSON Schema");
      for (const child of children) schemas.push({ schema: child, depth: depth + 1 });
    }
    for (const keyword of mapSchemaKeywords) {
      const children = record[keyword];
      if (children === undefined) continue;
      if (!children || typeof children !== "object" || Array.isArray(children)) throw new Error("MCP tool input schema is not a valid JSON Schema");
      for (const child of Object.values(children)) schemas.push({ schema: child, depth: depth + 1 });
    }
  }
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
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
