import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SecretStore {
  get(key: string, signal?: AbortSignal): Promise<string | undefined>;
  set(key: string, value: string, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<boolean>;
}

export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: readonly string[], input?: string, signal?: AbortSignal) => Promise<CommandResult>;

export class OsSecretStore implements SecretStore {
  readonly #runner: CommandRunner;
  #windowsTail = Promise.resolve();

  constructor(private readonly options: {
    service?: string;
    platform?: NodeJS.Platform;
    windowsPath?: string;
    runner?: CommandRunner;
  } = {}) {
    this.#runner = options.runner ?? runCommand;
  }

  async get(key: string, signal?: AbortSignal): Promise<string | undefined> {
    validateKey(key);
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      return await this.#withWindowsLock(async () => {
        const encrypted = (await this.#readWindows())[key];
        if (!encrypted) return undefined;
        const result = await this.#runner("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT], encrypted, signal);
        if (result.code !== 0) throw new Error("Windows DPAPI credential decryption failed");
        return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
      });
    }
    const service = this.options.service ?? "lite-harness";
    const result = platform === "darwin"
      ? await this.#runner("/usr/bin/security", ["find-generic-password", "-s", service, "-a", key, "-w"], undefined, signal)
      : await this.#runner("secret-tool", ["lookup", "service", service, "account", key], undefined, signal);
    if (result.code === 1) return undefined;
    if (result.code !== 0) throw new Error("Operating-system credential lookup failed");
    return result.stdout.replace(/[\r\n]+$/, "");
  }

  async set(key: string, value: string, signal?: AbortSignal): Promise<void> {
    validateKey(key); validateValue(value);
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      await this.#withWindowsLock(async () => {
        const result = await this.#runner("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_PROTECT], Buffer.from(value).toString("base64"), signal);
        if (result.code !== 0 || !result.stdout.trim()) throw new Error("Windows DPAPI credential encryption failed");
        const values = await this.#readWindows(); values[key] = result.stdout.trim(); await this.#writeWindows(values);
      });
      return;
    }
    const service = this.options.service ?? "lite-harness";
    const result = platform === "darwin"
      ? await this.#runner("/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", key, "-w", value], undefined, signal)
      : await this.#runner("secret-tool", ["store", `--label=Lite-Harness ${key}`, "service", service, "account", key], value, signal);
    if (result.code !== 0) throw new Error("Operating-system credential storage failed");
  }

  async delete(key: string, signal?: AbortSignal): Promise<boolean> {
    validateKey(key);
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      return await this.#withWindowsLock(async () => {
        const values = await this.#readWindows();
        if (!(key in values)) return false;
        delete values[key]; await this.#writeWindows(values); return true;
      });
    }
    const service = this.options.service ?? "lite-harness";
    const result = platform === "darwin"
      ? await this.#runner("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", key], undefined, signal)
      : await this.#runner("secret-tool", ["clear", "service", service, "account", key], undefined, signal);
    if (result.code === 1) return false;
    if (result.code !== 0) throw new Error("Operating-system credential deletion failed");
    return true;
  }

  async #readWindows(): Promise<Record<string, string>> {
    const path = this.#windowsPath();
    try {
      let source: string;
      try { source = await readFile(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        source = await readFile(`${path}.bak`, "utf8");
      }
      const parsed = JSON.parse(source) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          !Object.values(parsed).every((value) => typeof value === "string")) throw new Error("Credential index is malformed");
      return parsed as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async #writeWindows(values: Record<string, string>): Promise<void> {
    const path = this.#windowsPath();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const backup = `${path}.bak`;
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    await rm(backup, { force: true });
    try { await rename(path, backup); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      await rename(temporary, path);
      await rm(backup, { force: true });
    } catch (error) {
      try { await rename(backup, path); } catch { /* preserve the original error */ }
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }

  #windowsPath(): string {
    if (!this.options.windowsPath) throw new Error("A Windows DPAPI credential index path is required");
    return this.options.windowsPath;
  }

  async #withWindowsLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#windowsTail;
    let release!: () => void;
    this.#windowsTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try { return await operation(); } finally { release(); }
  }
}

const DPAPI_PROTECT = "$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
const DPAPI_UNPROTECT = "$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";

async function runCommand(command: string, args: readonly string[], input?: string, signal?: AbortSignal): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(signal ? { signal } : {}) });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let size = 0; let settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("Credential helper timed out")); }, 30_000);
    timer.unref?.();
    const finish = (result: CommandResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { child.kill("SIGKILL"); fail(new Error("Credential helper output exceeded 1 MiB")); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", fail);
    child.once("close", (code) => finish({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(input);
  });
}

function validateKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new Error("Credential key is invalid");
}

function validateValue(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error("Credential value must contain 1-65536 UTF-8 bytes");
}
