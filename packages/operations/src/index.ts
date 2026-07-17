import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, rmSync as rmFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { chmod, lstat, mkdir, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ServiceInstallOptions {
  root: string;
  dataDir: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  home?: string;
  runner?: ServiceCommandRunner;
}

export interface ServiceCommandResult { code: number; stdout: string; stderr?: string }
export type ServiceCommandRunner = (command: string, args: readonly string[]) => Promise<ServiceCommandResult>;

export interface RenderedService {
  path: string;
  content: string;
  command: string;
  args: readonly string[];
}

const SERVICE_ID = "dev.lite-harness";

export interface ManagerInstanceOwner {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  socketPath: string;
  protocolVersion: string;
  startedAt: string;
}

export interface ManagerInstanceLockOptions {
  dataDir: string;
  socketPath: string;
  protocolVersion: string;
  platform?: NodeJS.Platform;
  processId?: number;
  probeTimeoutMs?: number;
}

/**
 * Cross-platform, ownership-checked Manager singleton guard.
 *
 * The lock directory is created atomically before any database or endpoint is
 * opened. A contender never removes an endpoint while the recorded process or
 * endpoint is live, and cleanup only removes state owned by this instance.
 */
export class ManagerInstanceLock {
  readonly owner: ManagerInstanceOwner;
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #probeTimeoutMs: number;
  #acquired = false;
  #endpointOwned = false;

  constructor(private readonly options: ManagerInstanceLockOptions) {
    const dataDir = resolve(options.dataDir);
    this.lockPath = resolve(dataDir, "manager.lock");
    if (dirname(this.lockPath) !== dataDir || basename(this.lockPath) !== "manager.lock") {
      throw new Error("Manager lock must remain directly under the configured data directory");
    }
    this.ownerPath = join(this.lockPath, "owner.json");
    this.#platform = options.platform ?? process.platform;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 750;
    this.owner = {
      schemaVersion: 1,
      instanceId: randomUUID(),
      pid: options.processId ?? process.pid,
      socketPath: options.socketPath,
      protocolVersion: options.protocolVersion,
      startedAt: new Date().toISOString(),
    };
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        const handle = await open(this.ownerPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(this.owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.#acquired = true;
        try {
          await this.#prepareEndpoint();
        } catch (error) {
          await this.release();
          throw error;
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await this.#readExistingOwner();
      const endpointLive = await probeManagerEndpoint(this.options.socketPath, undefined, this.#probeTimeoutMs);
      if (endpointLive || (existing && processIsAlive(existing.pid))) {
        const identity = existing ? `pid ${existing.pid}, instance ${existing.instanceId}` : "an initializing instance";
        throw new Error(`A Lite-Harness Manager is already active (${identity})`);
      }

      const metadata = await lstat(this.lockPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Manager lock path is not a safe local directory");
      }
      if (!existing) {
        if (Date.now() - metadata.mtimeMs < 30_000) {
          throw new Error("A Lite-Harness Manager lock is being initialized");
        }
      }
      await rm(this.lockPath, { recursive: true, force: true });
    }
    throw new Error("Could not acquire the Lite-Harness Manager instance lock");
  }

  async secureEndpoint(): Promise<void> {
    if (!this.#acquired) throw new Error("Manager instance lock is not held");
    this.#endpointOwned = true;
    if (this.#platform !== "win32") await chmod(this.options.socketPath, 0o600);
  }

  async release(): Promise<void> {
    if (!this.#acquired) return;
    const existing = await this.#readExistingOwner();
    if (existing?.instanceId !== this.owner.instanceId) {
      this.#acquired = false;
      this.#endpointOwned = false;
      return;
    }
    if (this.#platform !== "win32" && this.#endpointOwned) {
      await unlink(this.options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rm(this.lockPath, { recursive: true, force: true });
    this.#acquired = false;
    this.#endpointOwned = false;
  }

  async #prepareEndpoint(): Promise<void> {
    if (this.#platform === "win32") return;
    let metadata;
    try {
      metadata = await lstat(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!metadata.isSocket()) throw new Error("Configured Manager endpoint exists and is not a Unix socket");
    if (await probeManagerEndpoint(this.options.socketPath, undefined, this.#probeTimeoutMs)) {
      throw new Error("A live Manager endpoint exists without an owned lock; refusing unsafe cleanup");
    }
    await unlink(this.options.socketPath);
  }

  async #readExistingOwner(): Promise<ManagerInstanceOwner | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.ownerPath, "utf8")) as Partial<ManagerInstanceOwner>;
      return parsed.schemaVersion === 1 && typeof parsed.instanceId === "string" &&
        Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0 &&
        typeof parsed.socketPath === "string" && typeof parsed.protocolVersion === "string" &&
        typeof parsed.startedAt === "string"
        ? parsed as ManagerInstanceOwner
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
}

export async function probeManagerEndpoint(
  socketPath: string,
  protocolVersion?: string,
  timeoutMs = 750,
): Promise<boolean> {
  return await new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
    const request = httpRequest({ socketPath, path: "/healthz", method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 32 * 1024) chunks.push(chunk);
        else request.destroy();
      });
      response.once("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          finish(response.statusCode === 200 && payload.ok === true && payload.role === "manager" &&
            (protocolVersion === undefined || payload.protocolVersion === protocolVersion));
        } catch {
          finish(false);
        }
      });
    });
    request.once("error", () => finish(false));
    request.setTimeout(timeoutMs, () => request.destroy());
    request.once("close", () => finish(false));
    request.end();
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class RedactedStreamBuffer {
  readonly #decoder = new StringDecoder("utf8");
  #pending = "";
  #discardingOversizedLine = false;
  #ended = false;

  constructor(
    private readonly emit: (redactedText: string) => void,
    private readonly maxLineBytes = 256 * 1024,
  ) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > 16 * 1024 * 1024) {
      throw new Error("Service log line bound must be a positive safe integer no larger than 16 MiB");
    }
  }

  write(chunk: string | Buffer): void {
    if (this.#ended) throw new Error("Cannot write to an ended service log stream");
    this.#accept(this.#decoder.write(Buffer.from(chunk)));
  }

  end(chunk?: string | Buffer): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#accept(chunk === undefined ? this.#decoder.end() : this.#decoder.end(Buffer.from(chunk)));
    if (!this.#discardingOversizedLine && this.#pending) this.emit(redactServiceLog(this.#pending));
    this.#pending = "";
    this.#discardingOversizedLine = false;
  }

  #accept(decoded: string): void {
    this.#pending += decoded;
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline + 1);
      this.#pending = this.#pending.slice(newline + 1);
      if (this.#discardingOversizedLine) {
        this.#discardingOversizedLine = false;
      } else if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.emit("[REDACTED OVERSIZED LOG LINE]\n");
      } else {
        this.emit(redactServiceLog(line));
      }
      newline = this.#pending.indexOf("\n");
    }
    if (Buffer.byteLength(this.#pending) > this.maxLineBytes) {
      if (!this.#discardingOversizedLine) this.emit("[REDACTED OVERSIZED LOG LINE]\n");
      this.#pending = "";
      this.#discardingOversizedLine = true;
    }
  }
}

export class RotatingLogSink {
  readonly #buffers = new Map<string, RedactedStreamBuffer>();

  constructor(private readonly path: string, private readonly maxBytes = 10 * 1024 * 1024, private readonly generations = 5) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(source: string, stream: "stdout" | "stderr", chunk: string | Buffer): void {
    const key = `${source}\0${stream}`;
    let buffer = this.#buffers.get(key);
    if (!buffer) {
      buffer = new RedactedStreamBuffer((message) => this.#append(source, stream, message));
      this.#buffers.set(key, buffer);
    }
    buffer.write(chunk);
  }

  flush(source: string, stream: "stdout" | "stderr"): void {
    const key = `${source}\0${stream}`;
    const buffer = this.#buffers.get(key);
    if (!buffer) return;
    this.#buffers.delete(key);
    buffer.end();
  }

  flushAll(): void {
    for (const buffer of this.#buffers.values()) buffer.end();
    this.#buffers.clear();
  }

  #append(source: string, stream: "stdout" | "stderr", message: string): void {
    const line = JSON.stringify({ at: new Date().toISOString(), source, stream, message });
    this.#rotate(Buffer.byteLength(line) + 1);
    appendFileSync(this.path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  }

  #rotate(incoming: number): void {
    let size = 0;
    try { size = statSync(this.path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (size + incoming <= this.maxBytes) return;
    rmFileSync(`${this.path}.${this.generations}`, { force: true });
    for (let generation = this.generations - 1; generation >= 1; generation -= 1) {
      try { renameSync(`${this.path}.${generation}`, `${this.path}.${generation + 1}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { renameSync(this.path, `${this.path}.1`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function renderUserService(options: ServiceInstallOptions): RenderedService {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const node = options.nodePath ?? process.execPath;
  const launcher = join(options.root, "dist", "apps", "launcher", "main.js");
  const args = [launcher, "--data-dir", options.dataDir];
  if (platform === "linux") {
    const path = join(home, ".config", "systemd", "user", "lite-harness.service");
    return {
      path,
      content: `[Unit]\nDescription=Lite-Harness local agent service\nAfter=docker.service\n\n[Service]\nType=simple\nWorkingDirectory=${systemdValue(options.root)}\nEnvironment=${systemdValue(`LITE_HARNESS_DATA_DIR=${options.dataDir}`)}\nExecStart=${systemdCommand(node, args)}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`,
      command: "systemctl", args: ["--user", "enable", "--now", "lite-harness.service"],
    };
  }
  if (platform === "darwin") {
    const path = join(home, "Library", "LaunchAgents", `${SERVICE_ID}.plist`);
    const programArguments = [node, ...args].map((value) => `<string>${xml(value)}</string>`).join("");
    return {
      path,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${SERVICE_ID}</string><key>ProgramArguments</key><array>${programArguments}</array><key>WorkingDirectory</key><string>${xml(options.root)}</string><key>EnvironmentVariables</key><dict><key>LITE_HARNESS_DATA_DIR</key><string>${xml(options.dataDir)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>\n`,
      command: "launchctl", args: ["bootstrap", `gui/${process.getuid?.() ?? 0}`, path],
    };
  }
  if (platform === "win32") {
    const path = join(options.dataDir, "lite-harness-task.xml");
    return {
      path,
      content: `<?xml version="1.0" encoding="UTF-8"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(windowsArguments(args))}</Arguments><WorkingDirectory>${xml(options.root)}</WorkingDirectory></Exec></Actions></Task>`,
      command: "schtasks.exe", args: ["/Create", "/TN", "Lite-Harness", "/XML", path, "/F"],
    };
  }
  throw new Error(`Unsupported service platform: ${platform}`);
}

export async function installUserService(options: ServiceInstallOptions): Promise<RenderedService> {
  const rendered = renderUserService(options);
  await mkdir(dirname(rendered.path), { recursive: true });
  await writeFile(rendered.path, rendered.content, { mode: 0o600, encoding: "utf8" });
  const runner = options.runner ?? runServiceCommand;
  if ((options.platform ?? process.platform) === "linux") {
    const reload = await runner("systemctl", ["--user", "daemon-reload"]);
    if (reload.code !== 0) throw new Error("systemd user daemon-reload failed");
  }
  const result = await runner(rendered.command, rendered.args);
  if (result.code !== 0) throw new Error("User service installation failed");
  if ((options.platform ?? process.platform) === "win32") {
    const started = await runner("schtasks.exe", ["/Run", "/TN", "Lite-Harness"]);
    if (started.code !== 0) throw new Error("Windows user task installation succeeded but could not start Lite-Harness");
  }
  return rendered;
}

export async function startUserService(options: ServiceInstallOptions): Promise<{ started: boolean; detail: string }> {
  const runner = options.runner ?? runServiceCommand;
  const [command, args] = serviceControlCommand(options.platform ?? process.platform, "start");
  const result = await runner(command, args);
  if (result.code !== 0) throw new Error("User service start failed");
  return { started: true, detail: result.stdout.trim() || command };
}

export async function stopUserService(options: ServiceInstallOptions): Promise<{ stopped: boolean; detail: string }> {
  const runner = options.runner ?? runServiceCommand;
  const [command, args] = serviceControlCommand(options.platform ?? process.platform, "stop");
  const result = await runner(command, args);
  const output = `${result.stdout}\n${result.stderr ?? ""}`;
  if (result.code !== 0 && !/not found|does not exist|not running/i.test(output)) {
    throw new Error("User service stop failed");
  }
  return { stopped: result.code === 0, detail: output.trim() || command };
}

export async function uninstallUserService(options: ServiceInstallOptions): Promise<boolean> {
  const rendered = renderUserService(options);
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runServiceCommand;
  const command = platform === "linux" ? ["systemctl", ["--user", "disable", "--now", "lite-harness.service"]] as const
    : platform === "darwin" ? ["launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, rendered.path]] as const
    : ["schtasks.exe", ["/Delete", "/TN", "Lite-Harness", "/F"]] as const;
  const result = await runner(command[0], command[1]);
  const output = `${result.stdout}\n${result.stderr ?? ""}`;
  if (result.code !== 0 && !/not found|does not exist/i.test(output)) throw new Error("User service removal failed");
  await rm(rendered.path, { force: true });
  if (platform === "linux") await runner("systemctl", ["--user", "daemon-reload"]);
  return result.code === 0;
}

export async function userServiceStatus(options: ServiceInstallOptions): Promise<{ active: boolean; detail: string }> {
  const rendered = renderUserService(options);
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runServiceCommand;
  const command = platform === "linux" ? ["systemctl", ["--user", "is-active", "lite-harness.service"]] as const
    : platform === "darwin" ? ["launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${SERVICE_ID}`]] as const
    : ["schtasks.exe", ["/Query", "/TN", "Lite-Harness"]] as const;
  const result = await runner(command[0], command[1]);
  const output = `${result.stdout}\n${result.stderr ?? ""}`.trim();
  const active = result.code === 0 && (platform !== "win32" || /(?:^|\n)\s*status\s*:\s*running\s*$/im.test(output) || /\brunning\b/i.test(output));
  return { active, detail: output || (active ? rendered.path : "inactive") };
}

function serviceControlCommand(platform: NodeJS.Platform, action: "start" | "stop"): [string, readonly string[]] {
  if (platform === "linux") return ["systemctl", ["--user", action, "lite-harness.service"]];
  if (platform === "darwin") {
    const target = `gui/${process.getuid?.() ?? 0}/${SERVICE_ID}`;
    return action === "start"
      ? ["launchctl", ["kickstart", target]]
      : ["launchctl", ["kill", "SIGTERM", target]];
  }
  return ["schtasks.exe", [action === "start" ? "/Run" : "/End", "/TN", "Lite-Harness"]];
}

async function runServiceCommand(command: string, args: readonly string[]): Promise<ServiceCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = []; let bytes = 0;
    const collect = (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); else child.kill("SIGKILL"); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", reject);
      child.once("close", (code) => resolve({ code: bytes > 1024 * 1024 ? 1 : code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

function systemdValue(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function systemdCommand(command: string, args: readonly string[]): string { return [command, ...args].map(systemdValue).join(" "); }
function windowsArguments(args: readonly string[]): string { return args.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(" "); }
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
export function redactServiceLog(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(["']?authorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,}\r\n]*)/gi, "$1[REDACTED]")
    .replace(/(["']?(?:set[_-]?)?cookie["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,}\r\n]*)/gi, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|token|secret|credential|password)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,\s}\r\n]+)/gi, "$1[REDACTED]");
}
