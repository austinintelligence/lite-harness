import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ToolCall, ToolResult } from "@lite-harness/contracts";
import type { ToolRuntime } from "@lite-harness/runtime";
import { validateWorkspacePath } from "@lite-harness/runtime";

export interface DockerRuntimeConfig {
  image: string;
  dockerCommand?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  maxOutputBytes?: number;
}

export interface DockerDoctorResult {
  available: boolean;
  clientVersion?: string;
  serverVersion?: string;
  error?: string;
}

export class DockerToolRuntime implements ToolRuntime {
  readonly #docker: string;
  readonly #readyVolumes = new Set<string>();
  readonly #maxOutputBytes: number;

  constructor(private readonly config: DockerRuntimeConfig) {
    if (!config.image.includes("@sha256:") && !/^sha256:[a-f0-9]{64}$/.test(config.image)) {
      throw new Error("Docker runtime image must be pinned by sha256 digest");
    }
    this.#docker = config.dockerCommand ?? "docker";
    this.#maxOutputBytes = config.maxOutputBytes ?? 4 * 1024 * 1024;
  }

  async doctor(): Promise<DockerDoctorResult> {
    try {
      const result = await runCommand(
        this.#docker,
        ["version", "--format", "{{.Client.Version}}|{{.Server.Version}}"],
        undefined,
        undefined,
        64 * 1024,
      );
      const [clientVersion, serverVersion] = result.stdout.trim().split("|");
      return {
        available: result.code === 0 && Boolean(serverVersion),
        ...(clientVersion ? { clientVersion } : {}),
        ...(serverVersion ? { serverVersion } : {}),
        ...(result.code === 0 ? {} : { error: result.stderr.trim() || "Docker returned an error" }),
      };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async execute(params: {
    workspaceId: string;
    call: ToolCall;
    signal?: AbortSignal;
  }): Promise<ToolResult> {
    params.signal?.throwIfAborted();
    const volume = volumeName(params.workspaceId);
    await this.#ensureVolume(volume, params.signal);

    if (params.call.name === "write_file") {
      const path = stringArgument(params.call, "path");
      const content = stringArgument(params.call, "content");
      validateWorkspacePath(path);
      const result = await this.#runTool(
        volume,
        [
          "sh",
          "-c",
          'set -eu; target="/workspace/$1"; mkdir -p "$(dirname "$target")"; cat > "$target"',
          "lite-write",
          path,
        ],
        content,
        params.signal,
      );
      return commandResult(params.call.id, result, { path, bytes: Buffer.byteLength(content) });
    }

    if (params.call.name === "read_file") {
      const path = stringArgument(params.call, "path");
      validateWorkspacePath(path);
      const result = await this.#runTool(
        volume,
        ["sh", "-c", 'set -eu; cat -- "/workspace/$1"', "lite-read", path],
        undefined,
        params.signal,
      );
      return commandResult(params.call.id, result, { path });
    }

    return { callId: params.call.id, ok: false, content: `Unsupported tool: ${params.call.name}` };
  }

  async exportWorkspace(workspaceId: string, signal?: AbortSignal): Promise<Buffer> {
    const volume = volumeName(workspaceId);
    await this.#ensureVolume(volume, signal);
    const result = await runCommandBytes(
      this.#docker,
      [
        "run", "--rm", "--user", "1000:1000", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--volume", `${volume}:/workspace:ro`,
        this.config.image, "tar", "-C", "/workspace", "-cf", "-", ".",
      ],
      undefined,
      signal,
      this.#maxOutputBytes * 16,
    );
    if (result.code !== 0) throw new Error(`Could not export workspace: ${result.stderr.toString("utf8")}`);
    return result.stdout;
  }

  async importWorkspace(workspaceId: string, archive: Buffer, signal?: AbortSignal): Promise<void> {
    const target = volumeName(workspaceId);
    await this.#ensureVolume(target, signal);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const staging = `${target}-staging-${suffix}`;
    const backup = `${target}-backup-${suffix}`;
    try {
      await this.#createRawVolume(staging, signal);
      await this.#createRawVolume(backup, signal);
      const extract = await runCommandBytes(
        this.#docker,
        [
          "run", "--rm", "--interactive", "--network", "none", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges", "--volume", `${staging}:/staging`,
          this.config.image, "tar", "-C", "/staging", "-xf", "-",
        ],
        archive,
        signal,
        this.#maxOutputBytes,
      );
      if (extract.code !== 0) throw new Error(`Could not stage workspace restore: ${extract.stderr.toString("utf8")}`);
      await this.#copyVolume(target, backup, signal);
      try {
        await this.#replaceVolumeContents(staging, target, signal);
      } catch (error) {
        await this.#replaceVolumeContents(backup, target, signal);
        throw error;
      }
    } finally {
      await runCommand(this.#docker, ["volume", "rm", "--force", staging], undefined, undefined).catch(() => undefined);
      await runCommand(this.#docker, ["volume", "rm", "--force", backup], undefined, undefined).catch(() => undefined);
    }
  }

  async removeWorkspace(workspaceId: string): Promise<boolean> {
    const volume = volumeName(workspaceId);
    const result = await runCommand(this.#docker, ["volume", "rm", volume], undefined, undefined);
    this.#readyVolumes.delete(volume);
    return result.code === 0;
  }

  async #ensureVolume(volume: string, signal?: AbortSignal): Promise<void> {
    if (this.#readyVolumes.has(volume)) {
      return;
    }
    const create = await runCommand(this.#docker, ["volume", "create", volume], undefined, signal);
    if (create.code !== 0) {
      throw new Error(`Could not create workspace volume: ${create.stderr}`);
    }
    const initialize = await runCommand(
      this.#docker,
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "FOWNER",
        "--security-opt",
        "no-new-privileges",
        "--volume",
        `${volume}:/workspace`,
        this.config.image,
        "sh",
        "-c",
        "touch /workspace/.lite-harness-workspace && chown -R 1000:1000 /workspace && chmod 0700 /workspace",
      ],
      undefined,
      signal,
    );
    if (initialize.code !== 0) {
      throw new Error(`Could not initialize workspace volume: ${initialize.stderr}`);
    }
    this.#readyVolumes.add(volume);
  }

  async #createRawVolume(volume: string, signal?: AbortSignal): Promise<void> {
    const result = await runCommand(this.#docker, ["volume", "create", volume], undefined, signal);
    if (result.code !== 0) throw new Error(`Could not create staging volume: ${result.stderr}`);
  }

  async #copyVolume(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const result = await runCommand(
      this.#docker,
      [
        "run", "--rm", "--network", "none", "--cap-drop", "ALL",
        "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
        "--security-opt", "no-new-privileges",
        "--volume", `${source}:/source:ro`, "--volume", `${destination}:/destination`,
        this.config.image, "sh", "-c", "cp -a /source/. /destination/",
      ],
      undefined,
      signal,
    );
    if (result.code !== 0) throw new Error(`Could not copy workspace volume: ${result.stderr}`);
  }

  async #replaceVolumeContents(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const result = await runCommand(
      this.#docker,
      [
        "run", "--rm", "--network", "none", "--cap-drop", "ALL",
        "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
        "--security-opt", "no-new-privileges",
        "--volume", `${source}:/source:ro`, "--volume", `${destination}:/destination`,
        this.config.image, "sh", "-c",
        "find /destination -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /source/. /destination/ && chown -R 1000:1000 /destination",
      ],
      undefined,
      signal,
    );
    if (result.code !== 0) throw new Error(`Could not replace workspace volume: ${result.stderr}`);
  }

  #runTool(
    volume: string,
    command: string[],
    input?: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return runCommand(
      this.#docker,
      [
        "run",
        "--rm",
        "--interactive",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(this.config.pidsLimit ?? 64),
        "--memory",
        this.config.memory ?? "256m",
        "--cpus",
        this.config.cpus ?? "1",
        "--user",
        "1000:1000",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--volume",
        `${volume}:/workspace`,
        this.config.image,
        ...command,
      ],
      input,
      signal,
      this.#maxOutputBytes,
    );
  }
}

export async function inspectDocker(dockerCommand = "docker"): Promise<DockerDoctorResult> {
  try {
    const result = await runCommand(
      dockerCommand,
      ["version", "--format", "{{.Client.Version}}|{{.Server.Version}}"],
      undefined,
      undefined,
      64 * 1024,
    );
    const [clientVersion, serverVersion] = result.stdout.trim().split("|");
    return {
      available: result.code === 0 && Boolean(serverVersion),
      ...(clientVersion ? { clientVersion } : {}),
      ...(serverVersion ? { serverVersion } : {}),
      ...(result.code === 0 ? {} : { error: result.stderr.trim() || "Docker returned an error" }),
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface BinaryCommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function runCommand(
  command: string,
  args: string[],
  input?: string,
  signal?: AbortSignal,
  maxOutputBytes = 4 * 1024 * 1024,
): Promise<CommandResult> {
  return runCommandBytes(command, args, input, signal, maxOutputBytes).then((result) => ({
    code: result.code,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  }));
}

function runCommandBytes(
  command: string,
  args: string[],
  input?: string | Buffer,
  signal?: AbortSignal,
  maxOutputBytes = 4 * 1024 * 1024,
): Promise<BinaryCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        reject(new Error(`Docker command output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }
  });
}

function stringArgument(call: ToolCall, name: string): string {
  const value = call.arguments[name];
  if (typeof value !== "string") {
    throw new TypeError(`${call.name}.${name} must be a string`);
  }
  return value;
}

function volumeName(workspaceId: string): string {
  const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 24);
  return `lite-harness-ws-${digest}`;
}

export function dockerWorkspaceVolumeName(workspaceId: string): string {
  return volumeName(workspaceId);
}

function commandResult(
  callId: string,
  result: CommandResult,
  metadata: Record<string, unknown>,
): ToolResult {
  return result.code === 0
    ? { callId, ok: true, content: result.stdout || "ok", metadata }
    : { callId, ok: false, content: result.stderr || `Command exited with ${result.code}`, metadata };
}
