export interface McpTransport {
  start(): Promise<void>;
  call(tool: string, input: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

export class McpSupervisor {
  readonly #registrations = new Map<string, { factory: () => McpTransport; transport?: McpTransport }>();

  constructor(private readonly limits: { timeoutMs?: number; maxPayloadBytes?: number } = {}) {}

  register(serverId: string, factory: () => McpTransport): void {
    if (this.#registrations.has(serverId)) throw new Error(`MCP server already registered: ${serverId}`);
    this.#registrations.set(serverId, { factory });
  }

  isActive(serverId: string): boolean {
    return this.#registrations.get(serverId)?.transport !== undefined;
  }

  async call(serverId: string, tool: string, input: unknown): Promise<unknown> {
    const registration = this.#registrations.get(serverId);
    if (!registration) throw new Error(`MCP server is not registered: ${serverId}`);
    const inputBytes = Buffer.byteLength(JSON.stringify(input));
    if (inputBytes > (this.limits.maxPayloadBytes ?? 1024 * 1024)) throw new Error("MCP input exceeds the payload limit");
    if (!registration.transport) {
      registration.transport = registration.factory();
      await registration.transport.start();
    }
    try {
      const output = await withTimeout(
        registration.transport.call(tool, input),
        this.limits.timeoutMs ?? 15_000,
      );
      if (Buffer.byteLength(JSON.stringify(output)) > (this.limits.maxPayloadBytes ?? 1024 * 1024)) {
        throw new Error("MCP output exceeds the payload limit");
      }
      return output;
    } catch (error) {
      await this.stop(serverId);
      throw error;
    }
  }

  async stop(serverId: string): Promise<void> {
    const registration = this.#registrations.get(serverId);
    const transport = registration?.transport;
    if (registration) registration.transport = undefined;
    if (transport) await transport.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#registrations.keys()].map((id) => this.stop(id)));
  }
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
