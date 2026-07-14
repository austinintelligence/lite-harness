import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, rmSync as rmFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServiceInstallOptions {
  root: string;
  dataDir: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  home?: string;
  runner?: ServiceCommandRunner;
}

export interface ServiceCommandResult { code: number; stdout: string }
export type ServiceCommandRunner = (command: string, args: readonly string[]) => Promise<ServiceCommandResult>;

export interface RenderedService {
  path: string;
  content: string;
  command: string;
  args: readonly string[];
}

const SERVICE_ID = "dev.lite-harness";

export class RotatingLogSink {
  constructor(private readonly path: string, private readonly maxBytes = 10 * 1024 * 1024, private readonly generations = 5) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(source: string, stream: "stdout" | "stderr", chunk: string | Buffer): void {
    const line = JSON.stringify({ at: new Date().toISOString(), source, stream, message: redactLog(Buffer.from(chunk).toString("utf8")).slice(0, 256 * 1024) });
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
  const launcher = join(options.root, "apps", "launcher", "src", "main.ts");
  const args = ["--import", "tsx", launcher, "--data-dir", options.dataDir];
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
  return rendered;
}

export async function uninstallUserService(options: ServiceInstallOptions): Promise<boolean> {
  const rendered = renderUserService(options);
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runServiceCommand;
  const command = platform === "linux" ? ["systemctl", ["--user", "disable", "--now", "lite-harness.service"]] as const
    : platform === "darwin" ? ["launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, rendered.path]] as const
    : ["schtasks.exe", ["/Delete", "/TN", "Lite-Harness", "/F"]] as const;
  const result = await runner(command[0], command[1]);
  if (result.code !== 0 && !/not found|does not exist/i.test(result.stdout)) throw new Error("User service removal failed");
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
  return { active: result.code === 0, detail: result.stdout.trim() || (result.code === 0 ? rendered.path : "inactive") };
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
function redactLog(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"']{8,}/gi, "$1[REDACTED]");
}
