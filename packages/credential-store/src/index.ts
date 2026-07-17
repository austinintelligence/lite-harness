import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open as openFile, readFile, rename, rm, stat as statFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SecretStore {
  get(key: string, signal?: AbortSignal): Promise<string | undefined>;
  getOrCreate(key: string, createValue: () => string, signal?: AbortSignal): Promise<{ value: string; created: boolean }>;
  set(key: string, value: string, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Selects the OS store by default. An explicitly supplied recovery key opts
 * into the encrypted recovery-file backend for headless environments; there
 * is intentionally no implicit plaintext fallback.
 */
export function createCredentialStore(dataDir: string, environment: NodeJS.ProcessEnv = process.env): SecretStore {
  const recoveryPassphrase = environment.LITE_HARNESS_CREDENTIAL_RECOVERY_KEY?.trim();
  return recoveryPassphrase
    ? new EncryptedFileSecretStore({
      path: join(dataDir, "credentials.recovery.json"),
      passphrase: recoveryPassphrase,
    })
    : new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
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

  async getOrCreate(key: string, createValue: () => string, signal?: AbortSignal): Promise<{ value: string; created: boolean }> {
    validateKey(key);
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      return await this.#withWindowsLock(async () => {
        const values = await this.#readWindows();
        const encrypted = values[key];
        if (encrypted) return { value: await this.#unprotectWindows(encrypted, signal), created: false };
        const value = createValue();
        validateValue(value);
        values[key] = await this.#protectWindows(value, signal);
        await this.#writeWindows(values);
        return { value, created: true };
      });
    }
    const existing = await this.get(key, signal);
    if (existing !== undefined) return { value: existing, created: false };
    const value = createValue();
    validateValue(value);
    await this.set(key, value, signal);
    return { value, created: true };
  }

  async set(key: string, value: string, signal?: AbortSignal): Promise<void> {
    validateKey(key); validateValue(value);
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      await this.#withWindowsLock(async () => {
        const values = await this.#readWindows();
        values[key] = await this.#protectWindows(value, signal);
        await this.#writeWindows(values);
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

  async #protectWindows(value: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#runner(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_PROTECT],
      Buffer.from(value).toString("base64"),
      signal,
    );
    if (result.code !== 0 || !result.stdout.trim()) throw new Error("Windows DPAPI credential encryption failed");
    return result.stdout.trim();
  }

  async #unprotectWindows(encrypted: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#runner(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT],
      encrypted,
      signal,
    );
    if (result.code !== 0) throw new Error("Windows DPAPI credential decryption failed");
    return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
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
    const lockPath = `${this.#windowsPath()}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    const predecessor = this.#windowsTail;
    let release!: () => void;
    this.#windowsTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    let lock: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      lock = await this.#acquireWindowsLock(lockPath);
      return await operation();
    }
    finally {
      release();
      if (lock) {
        await lock.close();
        await rm(lockPath, { force: true });
      }
    }
  }

  async #acquireWindowsLock(lockPath: string): Promise<Awaited<ReturnType<typeof openFile>>> {
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        const lock = await openFile(lockPath, "wx", 0o600);
        await lock.writeFile(`${process.pid}\n`, "utf8");
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const metadata = await statFile(lockPath);
          if (Date.now() - metadata.mtimeMs > 30_000) {
            let ownerPid: number | undefined;
            try {
              const rawOwner = (await readFile(lockPath, "utf8")).trim();
              const parsedOwner = Number(rawOwner);
              if (Number.isSafeInteger(parsedOwner) && parsedOwner > 0) ownerPid = parsedOwner;
            } catch (readError) {
              if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
            }
            if (ownerPid === undefined || !processIsAlive(ownerPid)) {
              await rm(lockPath, { force: true });
              continue;
            }
          }
        } catch (metadataError) {
          if ((metadataError as NodeJS.ErrnoException).code !== "ENOENT") throw metadataError;
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Windows credential index lock acquisition timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

export class EncryptedFileSecretStore implements SecretStore {
  #tail = Promise.resolve();

  constructor(private readonly options: { path: string; passphrase: string }) {
    if (!options.path || options.passphrase.trim().length < 12) {
      throw new Error("Encrypted recovery credential storage requires a passphrase of at least 12 characters");
    }
  }

  async get(key: string): Promise<string | undefined> {
    validateKey(key);
    return await this.#withLock(async () => (await this.#read())[key]);
  }

  async getOrCreate(key: string, createValue: () => string): Promise<{ value: string; created: boolean }> {
    validateKey(key);
    return await this.#withLock(async () => {
      const values = await this.#read();
      if (values[key] !== undefined) return { value: values[key], created: false };
      const value = createValue();
      validateValue(value);
      values[key] = value;
      await this.#write(values);
      return { value, created: true };
    });
  }

  async set(key: string, value: string): Promise<void> {
    validateKey(key); validateValue(value);
    await this.#withLock(async () => {
      const values = await this.#read();
      values[key] = value;
      await this.#write(values);
    });
  }

  async delete(key: string): Promise<boolean> {
    validateKey(key);
    return await this.#withLock(async () => {
      const values = await this.#read();
      if (!(key in values)) return false;
      delete values[key];
      await this.#write(values);
      return true;
    });
  }

  async #read(): Promise<Record<string, string>> {
    let source: string;
    try { source = await readFile(this.options.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      const envelope = JSON.parse(source) as RecoveryEnvelope;
      if (envelope.schemaVersion !== 1 || envelope.algorithm !== "aes-256-gcm" ||
          typeof envelope.salt !== "string" || typeof envelope.iv !== "string" ||
          typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") {
        throw new Error("Recovery credential envelope is malformed");
      }
      const salt = Buffer.from(envelope.salt, "base64url");
      const iv = Buffer.from(envelope.iv, "base64url");
      const tag = Buffer.from(envelope.tag, "base64url");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error("Recovery credential envelope is malformed");
      const decipher = createDecipheriv("aes-256-gcm", recoveryKey(this.options.passphrase, salt), iv);
      decipher.setAuthTag(tag);
      const values = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as unknown;
      if (!values || typeof values !== "object" || Array.isArray(values) ||
          !Object.entries(values).every(([key, value]) => { validateKey(key); validateValue(String(value)); return typeof value === "string"; })) {
        throw new Error("Recovery credential payload is malformed");
      }
      return values as Record<string, string>;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Recovery credential")) throw error;
      throw new Error("Recovery credential store could not be decrypted");
    }
  }

  async #write(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", recoveryKey(this.options.passphrase, salt), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    const envelope: RecoveryEnvelope = {
      schemaVersion: 1,
      algorithm: "aes-256-gcm",
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    const temporary = `${this.options.path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const backup = `${this.options.path}.bak`;
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await rm(backup, { force: true });
    try { await rename(this.options.path, backup); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      await rename(temporary, this.options.path);
      await rm(backup, { force: true });
    } catch (error) {
      try { await rename(backup, this.options.path); } catch { /* preserve the original error */ }
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.options.path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    let lock: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      lock = await acquireFileLock(lockPath);
      return await operation();
    } finally {
      release();
      if (lock) {
        await lock.close();
        await rm(lockPath, { force: true });
      }
    }
  }
}

type RecoveryEnvelope = {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function recoveryKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function acquireFileLock(lockPath: string): Promise<Awaited<ReturnType<typeof openFile>>> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const lock = await openFile(lockPath, "wx", 0o600);
      await lock.writeFile(`${process.pid}\n`, "utf8");
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const metadata = await statFile(lockPath);
        if (Date.now() - metadata.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue; }
      } catch (metadataError) {
        if ((metadataError as NodeJS.ErrnoException).code !== "ENOENT") throw metadataError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Recovery credential store lock acquisition timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DPAPI_PROTECT = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
const DPAPI_UNPROTECT = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";

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
