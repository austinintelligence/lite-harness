import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProcessSpec {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  inheritEnv?: readonly string[];
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcServerRequest extends RpcNotification {
  id: string | number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

export class JsonLineRpcClient {
  readonly #events = new EventEmitter();
  readonly #pending = new Map<string | number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #stdout = "";
  #stderr = "";
  #nextId = 1;
  #stopping = false;
  #cleanupEnvironment: (() => void) | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(
    private readonly spec: ProcessSpec,
    private readonly options: {
      requestTimeoutMs?: number;
      maxLineBytes?: number;
      maxStderrBytes?: number;
      jsonRpcVersion?: "2.0";
      onServerRequest?: (request: RpcServerRequest) => Promise<unknown>;
    } = {},
  ) {}

  get running(): boolean {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  start(): void {
    if (this.running) return;
    this.#stopping = false;
    const environment = buildEnvironment(this.spec);
    this.#cleanupEnvironment = environment.cleanup;
    const child = spawn(this.spec.command, [...(this.spec.args ?? [])], {
      cwd: this.spec.cwd,
      env: environment.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#acceptStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      const limit = this.options.maxStderrBytes ?? 64 * 1024;
      this.#stderr = `${this.#stderr}${chunk}`.slice(-limit);
    });
    child.once("error", (error) => {
      this.#releaseEnvironment();
      this.#fail(error);
    });
    child.once("exit", (code, signal) => {
      const expected = this.#stopping;
      this.#child = undefined;
      this.#releaseEnvironment();
      if (!expected) {
        this.#fail(new ProcessRpcError(
          "process_exited",
          `RPC process exited (code=${code ?? "null"}, signal=${signal ?? "none"})${this.#stderr ? `: ${redact(this.#stderr.trim())}` : ""}`,
        ));
      }
      this.#events.emit("exit", { code, signal, expected });
    });
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.#events.on("notification", listener);
    return () => this.#events.off("notification", listener);
  }

  async request<T>(method: string, params?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    this.start();
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    return await new Promise<T>((resolve, reject) => {
      let pending: PendingRequest;
      const timer = setTimeout(() => void this.#cancelAndStop(
        id,
        pending,
        new ProcessRpcError("request_timeout", `RPC request timed out and its process was reaped: ${method}`),
      ), timeoutMs);
      timer.unref?.();
      pending = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        pending.abort = () => {
          void this.#cancelAndStop(id, pending, abortError(options.signal));
        };
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.#pending.set(id, pending);
      if (options.signal?.aborted) {
        pending.abort?.();
        return;
      }
      try {
        this.#send({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.#settle(id, error instanceof Error ? error : new Error(String(error)), true);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.start();
    this.#send({ method, ...(params === undefined ? {} : { params }) });
  }

  async stop(graceMs = 2_000): Promise<void> {
    if (this.#stopPromise) return await this.#stopPromise;
    const operation = this.#stopChild(graceMs);
    this.#stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    }
  }

  async #stopChild(graceMs: number): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    child.stdin.end();
    child.kill("SIGTERM");
    await waitForExit(child, Math.max(0, graceMs));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      if (!await waitForExit(child, 2_000)) {
        throw new ProcessRpcError("process_reap_failed", "RPC process could not be reaped after SIGKILL");
      }
    }
    if (this.#child === child) this.#child = undefined;
    this.#releaseEnvironment();
    this.#fail(new ProcessRpcError("process_stopped", "RPC process stopped"));
  }

  async #cancelAndStop(id: string | number, pending: PendingRequest, error: Error): Promise<void> {
    if (this.#pending.get(id) !== pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    try {
      await this.stop(0);
      pending.reject(error);
    } catch (stopError) {
      pending.reject(new AggregateError([error, stopError], "RPC cancellation could not verify process reap"));
    }
  }

  #releaseEnvironment(): void {
    const cleanup = this.#cleanupEnvironment;
    this.#cleanupEnvironment = undefined;
    cleanup?.();
  }

  #send(message: unknown): void {
    const child = this.#child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new ProcessRpcError("process_unavailable", "RPC process is unavailable");
    }
    const framed = this.options.jsonRpcVersion && message && typeof message === "object"
      ? { jsonrpc: this.options.jsonRpcVersion, ...(message as Record<string, unknown>) }
      : message;
    child.stdin.write(`${JSON.stringify(framed)}\n`);
  }

  #acceptStdout(chunk: string): void {
    this.#stdout += chunk;
    const max = this.options.maxLineBytes ?? 4 * 1024 * 1024;
    if (Buffer.byteLength(this.#stdout) > max && !this.#stdout.includes("\n")) {
      this.#fail(new ProcessRpcError("line_too_large", "RPC process emitted an oversized line"));
      void this.stop();
      return;
    }
    let newline = this.#stdout.indexOf("\n");
    while (newline >= 0) {
      const line = this.#stdout.slice(0, newline).replace(/\r$/, "");
      this.#stdout = this.#stdout.slice(newline + 1);
      if (Buffer.byteLength(line) > max) {
        this.#fail(new ProcessRpcError("line_too_large", "RPC process emitted an oversized line"));
        void this.stop();
        return;
      }
      if (line.trim()) this.#acceptMessage(line);
      newline = this.#stdout.indexOf("\n");
    }
    if (Buffer.byteLength(this.#stdout) > max) {
      this.#fail(new ProcessRpcError("line_too_large", "RPC process emitted an oversized partial line"));
      void this.stop(0).catch(() => undefined);
    }
  }

  #acceptMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#fail(new ProcessRpcError("invalid_json", "RPC process emitted invalid JSON"));
      void this.stop();
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined && ("result" in message || "error" in message)) {
      if (message.error) {
        const body = message.error as Partial<RpcErrorBody>;
        this.#settle(id, new ProcessRpcError(String(body.code ?? "rpc_error"), body.message ?? "RPC request failed", body.data), true);
      } else {
        this.#settle(id, message.result, false);
      }
      return;
    }
    if (typeof message.method === "string" && id !== undefined) {
      void this.#answerServerRequest({ id, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
      return;
    }
    if (typeof message.method === "string") {
      this.#events.emit("notification", { method: message.method, ...(message.params === undefined ? {} : { params: message.params }) } satisfies RpcNotification);
    }
  }

  async #answerServerRequest(request: RpcServerRequest): Promise<void> {
    try {
      if (!this.options.onServerRequest) throw new ProcessRpcError("method_not_allowed", `Server request is not allowed: ${request.method}`);
      this.#send({ id: request.id, result: await this.options.onServerRequest(request) });
    } catch (error) {
      this.#send({
        id: request.id,
        error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  #settle(id: string | number, value: unknown, rejected: boolean): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    if (rejected) pending.reject(value instanceof Error ? value : new Error(String(value)));
    else pending.resolve(value);
  }

  #fail(error: Error): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, error, true);
  }
}

export class ProcessRpcError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) {
    super(message);
    this.name = "ProcessRpcError";
  }
}

export async function runJsonLineProcess(
  spec: ProcessSpec,
  options: {
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxLineBytes?: number;
    maxOutputBytes?: number;
    maxStderrBytes?: number;
    onMessage(message: unknown): void;
  },
): Promise<{ code: number; stderr: string }> {
  options.signal?.throwIfAborted();
  const environment = buildEnvironment(spec);
  const child = spawn(spec.command, [...(spec.args ?? [])], {
    cwd: spec.cwd,
    env: environment.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  const maxLine = options.maxLineBytes ?? 4 * 1024 * 1024;
  const maxOutput = options.maxOutputBytes ?? 16 * 1024 * 1024;
  let terminalError: Error | undefined;
  const terminate = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk: string) => {
    if (terminalError) return;
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      const size = Buffer.byteLength(line);
      outputBytes += size;
      if (size > maxLine || outputBytes > maxOutput) {
        terminate(new ProcessRpcError(
          size > maxLine ? "line_too_large" : "output_too_large",
          "Process stdout exceeded its configured JSONL boundary",
        ));
        return;
      }
      if (line.trim()) {
        try { options.onMessage(JSON.parse(line)); }
        catch { terminate(new ProcessRpcError("invalid_json", "Process emitted invalid JSONL output")); }
      }
      newline = stdout.indexOf("\n");
    }
    if (Buffer.byteLength(stdout) > maxLine) {
      terminate(new ProcessRpcError("line_too_large", "Process emitted an oversized partial JSONL line"));
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-(options.maxStderrBytes ?? 64 * 1024));
  });
  const timeout = setTimeout(() => terminate(new ProcessRpcError(
    "process_timeout",
    "Process timed out and was forcefully reaped",
  )), options.timeoutMs ?? 15 * 60_000);
  timeout.unref?.();
  const abort = () => terminate(abortError(options.signal));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (terminalError) return reject(terminalError);
        if (options.signal?.aborted) return reject(abortError(options.signal));
        if (code !== 0) return reject(new ProcessRpcError("process_failed", `Process failed (code=${code ?? "null"}, signal=${signal ?? "none"}): ${redact(stderr.trim())}`));
        resolve({ code: 0, stderr: redact(stderr) });
      });
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    environment.cleanup();
  }
}

function buildEnvironment(spec: ProcessSpec): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const inherited: NodeJS.ProcessEnv = {};
  const inheritEnv = spec.inheritEnv ?? ["PATH", "Path", "SystemRoot", "TEMP", "TMP"];
  for (const name of inheritEnv) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  const explicitlyInheritedHome = inheritEnv.includes("HOME") || inheritEnv.includes("USERPROFILE");
  const configuredHome = spec.env?.HOME ?? spec.env?.USERPROFILE ??
    (explicitlyInheritedHome ? process.env.HOME ?? process.env.USERPROFILE : undefined);
  const isolatedChildHome = configuredHome ?? mkdtempSync(join(tmpdir(), "lite-process-home-"));
  let cleaned = false;
  return {
    env: {
      ...inherited,
      HOME: isolatedChildHome,
      USERPROFILE: isolatedChildHome,
      ...(spec.env ?? {}),
    },
    cleanup: () => {
      if (cleaned || configuredHome) return;
      cleaned = true;
      rmSync(isolatedChildHome, { recursive: true, force: true });
    },
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { cleanup(); resolve(true); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Process operation aborted");
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}
