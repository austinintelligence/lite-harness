import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  InternalPrincipal,
  RuntimeContainerRecord,
  RuntimeContainerState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@lite-harness/contracts";
import type { ToolExecutionContext, ToolRuntime } from "@lite-harness/runtime";
import { CODING_TOOL_DEFINITIONS, validateWorkspacePath, WORKSPACE_TOOL_DEFINITIONS } from "@lite-harness/runtime";

export interface DockerRuntimeConfig {
  image: string;
  dockerCommand?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
  workspaceQuotaBytes?: number;
  maxArchiveFiles?: number;
  /** Stable per-data-directory identity used to scope daemon reconciliation. */
  installationId?: string;
  containerStore?: DockerRuntimeContainerStore;
  commandRunner?: DockerCommandRunner;
  /** Trusted Manager-owned lookup. Arbitrary run input never becomes a bind source. */
  resolveRegisteredWorkspace?: (workspaceId: string, principal?: InternalPrincipal) => string | undefined;
  /** Optional Manager-owned lease fence checked immediately before Docker mutations. */
  validateExecutionLease?: (params: ToolExecutionContext) => boolean | Promise<boolean>;
}

export interface DockerCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DockerCommandOptions {
  input?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export type DockerCommandRunner = (
  args: readonly string[],
  options?: DockerCommandOptions,
) => Promise<DockerCommandResult>;

export interface DockerRuntimeContainerStore {
  recordRuntimeContainer(record: RuntimeContainerRecord): void | Promise<void>;
  updateRuntimeContainerState(
    runtimeContainerId: string,
    state: RuntimeContainerState,
    updatedAt: string,
  ): void | Promise<void>;
  removeRuntimeContainer(runtimeContainerId: string): void | Promise<void>;
  listRuntimeContainers(): RuntimeContainerRecord[] | Promise<RuntimeContainerRecord[]>;
}

export interface DockerDoctorResult {
  available: boolean;
  clientVersion?: string;
  serverVersion?: string;
  activeContext?: string;
  serverOs?: string;
  architecture?: string;
  rootless?: boolean;
  error?: string;
}

export interface DockerImageReadiness {
  ok: boolean;
  imageId?: string;
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
    if (config.workspaceQuotaBytes !== undefined && (!Number.isSafeInteger(config.workspaceQuotaBytes) || config.workspaceQuotaBytes < 1024 * 1024)) {
      throw new Error("Workspace quota must be an integer of at least 1 MiB");
    }
    if (config.maxArchiveFiles !== undefined && (!Number.isSafeInteger(config.maxArchiveFiles) || config.maxArchiveFiles < 1)) {
      throw new Error("Workspace archive file limit must be a positive integer");
    }
    if (config.commandTimeoutMs !== undefined && (!Number.isSafeInteger(config.commandTimeoutMs) || config.commandTimeoutMs < 100 || config.commandTimeoutMs > 3_600_000)) {
      throw new Error("Docker command timeout must be between 100 and 3600000 milliseconds");
    }
    this.#docker = config.dockerCommand ?? "docker";
    this.#maxOutputBytes = config.maxOutputBytes ?? 4 * 1024 * 1024;
  }

  listTools(): readonly ToolDefinition[] { return [...WORKSPACE_TOOL_DEFINITIONS, ...CODING_TOOL_DEFINITIONS]; }

  async doctor(): Promise<DockerDoctorResult> {
    try {
      const result = await this.#run(
        ["version", "--format", "{{.Client.Version}}|{{.Server.Version}}"],
        { maxOutputBytes: 64 * 1024 },
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

  async imageReadiness(): Promise<DockerImageReadiness> {
    try {
      const result = await this.#run(
        ["image", "inspect", "--format", "{{.Id}}", this.config.image],
        { maxOutputBytes: 64 * 1024 },
      );
      const imageId = result.stdout.trim();
      return result.code === 0 && /^sha256:[a-f0-9]{64}$/i.test(imageId)
        ? { ok: true, imageId }
        : { ok: false, error: "Pinned runtime image is unavailable" };
    } catch {
      return { ok: false, error: "Pinned runtime image could not be inspected" };
    }
  }

  async execute(params: ToolExecutionContext): Promise<ToolResult> {
    params.signal?.throwIfAborted();
    await this.#assertExecutionLease(params);
    const mount = await this.#workspaceMount(params.workspaceId, params.signal, params.principal);

    if (params.call.name === "write_file") {
      const path = stringArgument(params.call, "path");
      const content = stringArgument(params.call, "content");
      validateWorkspacePath(path);
      const contentBytes = Buffer.byteLength(content);
      const quotaBytes = this.config.workspaceQuotaBytes ?? 1024 * 1024 * 1024;
      const usage = await this.#workspaceUsage(mount, path, params);
      if (usage.totalBytes - usage.existingBytes + contentBytes > quotaBytes) {
        throw new Error(`Workspace write exceeds the ${quotaBytes}-byte quota`);
      }
      const result = await this.#runTool(
        mount,
        [
          "sh",
          "-c",
          'set -eu; target="/workspace/$1"; mkdir -p "$(dirname "$target")"; cat > "$target"',
          "lite-write",
          path,
        ],
        content,
        params,
        "write",
      );
      return commandResult(params.call.id, result, { path, bytes: contentBytes });
    }

    if (params.call.name === "read_file") {
      const path = stringArgument(params.call, "path");
      validateWorkspacePath(path);
      const result = await this.#runTool(
        mount,
        ["sh", "-c", 'set -eu; cat -- "/workspace/$1"', "lite-read", path],
        undefined,
        params,
        "read",
      );
      return commandResult(params.call.id, result, { path });
    }

    if (params.call.name === "shell_exec") {
      const script = boundedStringArgument(params.call, "script", 65_536);
      const cwd = workspaceDirectoryArgument(params.call, "cwd");
      const result = await this.#runTool(
        mount, ["bash", "--noprofile", "--norc", "-o", "pipefail", "-s"], script,
        params, "shell", this.#maxOutputBytes, false, cwd,
      );
      return commandResult(params.call.id, result, { cwd });
    }

    if (params.call.name === "process_exec") {
      const argv = stringArrayArgument(params.call, "argv", 1, 256);
      const cwd = workspaceDirectoryArgument(params.call, "cwd");
      const result = await this.#runTool(mount, argv, undefined, params, "process", this.#maxOutputBytes, false, cwd);
      return commandResult(params.call.id, result, { cwd, executable: argv[0] });
    }

    if (params.call.name === "search_text") {
      const pattern = boundedStringArgument(params.call, "pattern", 4_096);
      const paths = optionalWorkspacePaths(params.call.arguments.paths);
      const glob = optionalBoundedString(params.call.arguments.glob, "glob", 1_024);
      const maximum = optionalInteger(params.call.arguments.maxMatchesPerFile, "maxMatchesPerFile", 1, 10_000, 1_000);
      const args = [
        "rg", "--line-number", "--column", "--no-heading", "--color=never", "--max-count", String(maximum),
        ...(params.call.arguments.fixedStrings === true ? ["--fixed-strings"] : []),
        ...(glob ? ["--glob", glob] : []), "--", pattern, ...(paths.length ? paths : ["."]),
      ];
      const result = await this.#runTool(mount, args, undefined, params, "search", this.#maxOutputBytes, true);
      return commandResult(params.call.id, result.code === 1 ? { ...result, code: 0 } : result, { matchesFound: Boolean(result.stdout) });
    }

    if (params.call.name === "patch_apply") {
      const patch = boundedStringArgument(params.call, "patch", 1024 * 1024);
      const git = ["git", "-c", "core.hooksPath=/dev/null", "apply", "--whitespace=nowarn", "-"];
      const checked = await this.#runTool(mount, [...git.slice(0, -1), "--check", "-"], patch, params, "patch-check");
      if (checked.code !== 0) return commandResult(params.call.id, checked, { applied: false });
      const applied = await this.#runTool(mount, git, patch, params, "patch-apply");
      return commandResult(params.call.id, applied, { applied: applied.code === 0 });
    }

    if (params.call.name === "git_exec") {
      const args = stringArrayArgument(params.call, "args", 1, 256);
      assertAllowedGitSubcommand(args[0] as string);
      const result = await this.#runTool(mount, [
        "git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "--no-optional-locks", ...args,
      ], undefined, params, "git");
      return commandResult(params.call.id, result, { subcommand: args[0] });
    }

    if (params.call.name === "test_run" || params.call.name === "build_run" || params.call.name === "package_run") {
      const manager = packageManagerArgument(params.call.arguments.manager);
      const cwd = workspaceDirectoryArgument(params.call, "cwd");
      const args = optionalStringArray(params.call.arguments.args, "args", 64);
      const executable = manager === "npm" ? ["npm"] : ["corepack", manager];
      const command = params.call.name === "package_run"
        ? [...executable, "pack", ...args]
        : [...executable, "run", optionalBoundedString(params.call.arguments.script, "script", 128) ?? (params.call.name === "test_run" ? "test" : "build"), "--", ...args];
      const result = await this.#runTool(mount, command, undefined, params, params.call.name, this.#maxOutputBytes, false, cwd);
      return commandResult(params.call.id, result, { manager, cwd });
    }

    return { callId: params.call.id, ok: false, content: `Unsupported tool: ${params.call.name}` };
  }

  async readWorkspaceArtifact(params: ToolExecutionContext & { path: string; maxBytes: number }): Promise<Buffer> {
    params.signal?.throwIfAborted();
    await this.#assertExecutionLease(params);
    validateWorkspacePath(params.path);
    if (!Number.isSafeInteger(params.fencingToken) || (params.fencingToken as number) < 1) {
      throw new Error("Artifact fencing token is invalid");
    }
    if (!Number.isSafeInteger(params.maxBytes) || params.maxBytes < 1) throw new Error("Artifact size limit is invalid");
    const mount = await this.#workspaceMount(params.workspaceId, params.signal, params.principal);
    const result = await this.#runTool(
      mount,
      ["sh", "-c", 'set -eu; target="/workspace/$1"; resolved=$(realpath -e -- "$target"); case "$resolved" in /workspace/*) ;; *) echo "Artifact path escapes workspace" >&2; exit 1 ;; esac; test -f "$resolved"; size=$(wc -c < "$resolved"); test "$size" -le "$2"; base64 "$resolved"', "lite-artifact", params.path, String(params.maxBytes)],
      undefined,
      params,
      "artifact-read",
      Math.ceil(params.maxBytes * 1.4) + 64 * 1024,
      true,
    );
    if (result.code !== 0) throw new Error(`Could not read authorized workspace artifact: ${result.stderr}`);
    const encoded = result.stdout.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Workspace artifact encoding was invalid");
    const data = Buffer.from(encoded, "base64");
    if (data.length > params.maxBytes || data.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new Error("Workspace artifact exceeded its limit or was malformed");
    }
    return data;
  }

  async exportWorkspace(workspaceId: string, principal?: InternalPrincipal, signal?: AbortSignal): Promise<Buffer> {
    const mount = await this.#workspaceMount(workspaceId, signal, principal);
    const quotaBytes = this.config.workspaceQuotaBytes ?? 1024 * 1024 * 1024;
    const result = await runCommandBytes(
      this.#docker,
      [
        "run", "--pull=never", "--rm", ...dockerMaintenanceHardeningArgs(this.config, { user: "1000:1000" }),
        ...mountArgs(mount, true),
        this.config.image, "tar", "-C", "/workspace", "-cf", "-", ".",
      ],
      undefined,
      signal,
      quotaBytes + 64 * 1024 * 1024,
    );
    if (result.code !== 0) throw new Error(`Could not export workspace: ${result.stderr.toString("utf8")}`);
    validateArchiveEntries(result.stdout, { maxBytes: quotaBytes, maxFiles: this.config.maxArchiveFiles });
    return result.stdout;
  }

  async workspaceExists(workspaceId: string, principal: InternalPrincipal, signal?: AbortSignal): Promise<boolean> {
    if (this.#registeredPath(workspaceId, principal)) return true;
    const result = await this.#run(["volume", "inspect", volumeName(workspaceIdentity(workspaceId, principal))], { signal });
    if (result.code === 0) return true;
    if (/no such volume/i.test(result.stderr)) return false;
    throw new Error(`Could not inspect workspace volume: ${result.stderr}`);
  }

  async importWorkspace(workspaceId: string, archive: Buffer, principal?: InternalPrincipal, signal?: AbortSignal): Promise<void> {
    if (this.#registeredPath(workspaceId, principal)) throw new Error("Registered bind workspaces cannot be replaced by snapshot restore");
    validateArchiveEntries(archive, {
      maxBytes: this.config.workspaceQuotaBytes ?? 1024 * 1024 * 1024,
      maxFiles: this.config.maxArchiveFiles,
    });
    const target = volumeName(workspaceIdentity(workspaceId, principal));
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
          "run", "--pull=never", "--rm", "--interactive", ...dockerMaintenanceHardeningArgs(this.config, {
            capabilities: ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
            user: "0:0",
          }),
          "--volume", `${staging}:/staging`,
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

  async removeWorkspace(workspaceId: string, principal?: InternalPrincipal): Promise<boolean> {
    if (this.#registeredPath(workspaceId, principal)) throw new Error("Registered bind workspaces cannot be deleted by Lite-Harness");
    const volume = volumeName(workspaceIdentity(workspaceId, principal));
    const result = await this.#run(["volume", "rm", volume]);
    this.#readyVolumes.delete(volume);
    return result.code === 0;
  }

  async #ensureVolume(volume: string, signal?: AbortSignal): Promise<void> {
    if (this.#readyVolumes.has(volume)) {
      return;
    }
    const create = await this.#run(["volume", "create", volume], { signal });
    if (create.code !== 0) {
      throw new Error(`Could not create workspace volume: ${create.stderr}`);
    }
    // Root ownership is the trusted initialization commit: untrusted tool containers run as
    // 1000:1000 with every capability dropped, and maintenance writes the root owner last.
    // Workspace content (including the compatibility marker) is intentionally not trusted.
    const initialize = await this.#run(
      [
        "run",
        "--pull=never",
        "--rm",
        ...dockerMaintenanceHardeningArgs(this.config, { capabilities: ["CHOWN", "FOWNER", "DAC_OVERRIDE"], user: "0:0" }),
        "--mount",
        `type=volume,src=${volume},dst=/workspace,volume-nocopy`,
        this.config.image,
        "sh",
        "-c",
        "if [ \"$(stat -c '%u:%g' /workspace)\" != '1000:1000' ]; then rm -f -- /workspace/.lite-harness-workspace && touch /workspace/.lite-harness-workspace && find /workspace -mindepth 1 -exec chown -h 1000:1000 {} + && chmod 0700 /workspace && chown 1000:1000 /workspace; fi",
      ],
      { signal },
    );
    if (initialize.code !== 0) {
      throw new Error(`Could not initialize workspace volume: ${initialize.stderr}`);
    }
    this.#readyVolumes.add(volume);
  }

  async #createRawVolume(volume: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#run(["volume", "create", volume], { signal });
    if (result.code !== 0) throw new Error(`Could not create staging volume: ${result.stderr}`);
  }

  async #copyVolume(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#run(
      [
        "run", "--pull=never", "--rm", ...dockerMaintenanceHardeningArgs(this.config, {
          capabilities: ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
          user: "0:0",
        }),
        "--volume", `${source}:/source:ro`, "--volume", `${destination}:/destination`,
        this.config.image, "sh", "-c", "cp -a /source/. /destination/",
      ],
      { signal },
    );
    if (result.code !== 0) throw new Error(`Could not copy workspace volume: ${result.stderr}`);
  }

  async #replaceVolumeContents(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#run(
      [
        "run", "--pull=never", "--rm", ...dockerMaintenanceHardeningArgs(this.config, {
          capabilities: ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
          user: "0:0",
        }),
        "--volume", `${source}:/source:ro`, "--volume", `${destination}:/destination`,
        this.config.image, "sh", "-c",
        "find /destination -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /source/. /destination/ && chown -R 1000:1000 /destination",
      ],
      { signal },
    );
    if (result.code !== 0) throw new Error(`Could not replace workspace volume: ${result.stderr}`);
  }

  async #workspaceMount(workspaceId: string, signal?: AbortSignal, principal?: InternalPrincipal): Promise<WorkspaceMount> {
    const registered = this.#registeredPath(workspaceId, principal);
    if (registered) return { kind: "bind", source: registered };
    const volume = volumeName(workspaceIdentity(workspaceId, principal));
    await this.#ensureVolume(volume, signal);
    return { kind: "volume", source: volume };
  }

  async #workspaceUsage(
    mount: WorkspaceMount,
    path: string,
    params: ToolExecutionContext,
  ): Promise<{ totalBytes: number; existingBytes: number }> {
    const result = await this.#runTool(
      mount,
      ["sh", "-c", 'set -eu; total=$(du -sk /workspace | cut -f1); target="/workspace/$1"; if [ -f "$target" ]; then old=$(wc -c < "$target"); else old=0; fi; printf "%s %s" "$total" "$old"', "lite-quota", path],
      undefined,
      params,
      "quota",
    );
    if (result.code !== 0) throw new Error(`Could not inspect workspace quota usage: ${result.stderr}`);
    const [kilobytes, existingBytes] = result.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(kilobytes) || !Number.isSafeInteger(existingBytes)) throw new Error("Workspace quota usage was invalid");
    return { totalBytes: kilobytes * 1024, existingBytes };
  }

  #registeredPath(workspaceId: string, principal?: InternalPrincipal): string | undefined {
    const configured = this.config.resolveRegisteredWorkspace?.(workspaceId, principal);
    if (!configured) return undefined;
    if (!isAbsolute(configured)) throw new Error(`Registered workspace path must be absolute: ${workspaceId}`);
    const path = realpathSync(configured);
    if (!statSync(path).isDirectory()) throw new Error(`Registered workspace path is not a directory: ${workspaceId}`);
    return path;
  }

  async #runTool(
    mount: WorkspaceMount,
    command: string[],
    input?: string,
    params?: ToolExecutionContext,
    operation = "tool",
    maxOutputBytes = this.#maxOutputBytes,
    readOnly = false,
    workingDirectory = ".",
  ): Promise<DockerCommandResult> {
    if (!params?.runId || !params.attemptId || !params.principal) {
      throw new Error("Docker tool execution requires owned run and attempt context");
    }
    const containerStore = this.config.containerStore;
    const installationId = this.config.installationId?.trim();
    if (!containerStore || !installationId) {
      throw new Error("Docker tool execution requires durable container storage and an installation identity");
    }
    await this.#assertExecutionLease(params);
    const identity = workspaceIdentity(params.workspaceId, params.principal);
    const containerName = deterministicContainerName(
      installationId,
      identity,
      params.runId,
      params.attemptId,
      params.call.id,
      operation,
    );
    const label = (name: string, value: string) => ["--label", `lite-harness.${name}=${labelDigest(value)}`];
    const deadline = AbortSignal.timeout(this.config.commandTimeoutMs ?? 300_000);
    const toolSignal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
    const create = await this.#run(
      [
        "create",
        "--pull=never",
        "--name", containerName,
        "--label", "lite-harness.managed=true",
        ...label("installation", installationId),
        ...label("app", params.principal.appId),
        ...label("tenant", params.principal.tenantId),
        ...label("user", params.principal.userId),
        ...label("workspace", identity),
        ...label("run", params.runId),
        ...label("attempt", params.attemptId),
        ...label("tool-call", params.call.id),
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
        "--workdir",
        workingDirectory === "." ? "/workspace" : `/workspace/${workingDirectory.replaceAll("\\", "/")}`,
        ...mountArgs(mount, readOnly),
        this.config.image,
        ...command,
      ],
      { signal: toolSignal, maxOutputBytes },
    );
    if (create.code !== 0) throw new Error(`Could not create Docker tool container: ${create.stderr}`);
    const runtimeContainerId = create.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/i.test(runtimeContainerId)) {
      await killAndReapContainer((args, options) => this.#run(args, options), containerName).catch(() => undefined);
      throw new Error("Docker create returned an invalid container ID");
    }

    const now = new Date().toISOString();
    const record: RuntimeContainerRecord = {
      runtimeContainerId,
      containerName,
      runId: params.runId,
      attemptId: params.attemptId,
      workspaceIdentity: labelDigest(identity),
      toolCallId: params.call.id,
      state: "CREATED",
      createdAt: now,
      updatedAt: now,
    };
    let recorded = false;
    let result: DockerCommandResult | undefined;
    let executionError: unknown;
    try {
      await containerStore.recordRuntimeContainer(record);
      recorded = true;
      await containerStore.updateRuntimeContainerState(runtimeContainerId, "RUNNING", new Date().toISOString());
      await this.#assertExecutionLease(params);
      result = await this.#run(
        ["start", "--attach", "--interactive", runtimeContainerId],
        { ...(input === undefined ? {} : { input }), signal: toolSignal, maxOutputBytes },
      );
    } catch (error) {
      executionError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (recorded) {
      try {
        await containerStore.updateRuntimeContainerState(runtimeContainerId, "STOPPING", new Date().toISOString());
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    let reaped = false;
    try {
      await killAndReapContainer((args, options) => this.#run(args, options), runtimeContainerId);
      reaped = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (recorded && reaped) {
      try {
        await containerStore.removeRuntimeContainer(runtimeContainerId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (executionError && cleanupErrors.length) {
      throw new AggregateError([executionError, ...cleanupErrors], "Docker tool execution and cleanup both failed");
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Docker tool cleanup failed");
    if (executionError) throw executionError;
    return result!;
  }

  async reconcileContainers(): Promise<number> {
    const store = this.config.containerStore;
    const installationId = this.config.installationId?.trim();
    if (!store || !installationId) throw new Error("Docker reconciliation requires durable container storage and an installation identity");
    const listed = await this.#run([
      "ps", "--all", "--no-trunc",
      "--filter", "label=lite-harness.managed=true",
      "--filter", `label=lite-harness.installation=${labelDigest(installationId)}`,
      "--format", "{{.ID}}",
    ]);
    if (listed.code !== 0) throw new Error(`Could not list managed Docker containers: ${listed.stderr}`);
    const records = await store.listRuntimeContainers();
    const storedIds = new Set(records.map((record) => record.runtimeContainerId));
    const containerIds = new Set([
      ...records.map((record) => record.runtimeContainerId),
      ...listed.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    ]);
    const failures: unknown[] = [];
    let reaped = 0;
    for (const runtimeContainerId of containerIds) {
      try {
        await killAndReapContainer((args, options) => this.#run(args, options), runtimeContainerId);
        if (storedIds.has(runtimeContainerId)) await store.removeRuntimeContainer(runtimeContainerId);
        reaped += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Docker startup reconciliation failed");
    return reaped;
  }

  async #assertExecutionLease(params: ToolExecutionContext): Promise<void> {
    if (!this.config.validateExecutionLease) return;
    if (!params.runId || !params.attemptId || !params.principal || params.fencingToken === undefined ||
        !await this.config.validateExecutionLease(params)) {
      throw new Error("Workspace fence is not active");
    }
  }

  #run(args: readonly string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    if (this.config.commandRunner) return this.config.commandRunner(args, options);
    return runCommand(
      this.#docker,
      [...args],
      options.input,
      options.signal,
      options.maxOutputBytes ?? this.#maxOutputBytes,
    );
  }
}

interface WorkspaceMount { kind: "volume" | "bind"; source: string }

export async function killAndReapContainer(
  runner: DockerCommandRunner,
  runtimeContainerId: string,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runtimeContainerId)) {
    throw new Error("Runtime container ID is invalid");
  }
  const inspect = await runner([
    "container", "inspect", "--format", "{{.State.Running}}|{{.State.Status}}", runtimeContainerId,
  ]);
  if (inspect.code !== 0) {
    if (isNoSuchContainer(inspect)) return;
    throw new Error(`Could not inspect Docker tool container: ${inspect.stderr}`);
  }
  const [runningText, status] = inspect.stdout.trim().split("|");
  if (runningText !== "true" && runningText !== "false") {
    throw new Error("Docker tool container state was invalid");
  }
  const active = runningText === "true" || status === "running" || status === "restarting" || status === "paused";
  let waitForExit = active;
  if (active) {
    const killed = await runner(["container", "kill", runtimeContainerId]);
    if (killed.code !== 0) {
      if (isNoSuchContainer(killed) || isContainerNotRunning(killed)) waitForExit = false;
      else throw new Error(`Could not kill Docker tool container: ${killed.stderr}`);
    }
  }
  if (waitForExit) {
    const waited = await runner(["container", "wait", runtimeContainerId]);
    if (waited.code !== 0 && !isNoSuchContainer(waited)) {
      throw new Error(`Could not wait for Docker tool container: ${waited.stderr}`);
    }
  }
  const removed = await runner(["container", "rm", "--force", runtimeContainerId]);
  if (removed.code !== 0 && !isNoSuchContainer(removed)) {
    throw new Error(`Could not remove Docker tool container: ${removed.stderr}`);
  }
  const verified = await runner(["container", "inspect", runtimeContainerId]);
  if (verified.code === 0 || !isNoSuchContainer(verified)) {
    throw new Error("Docker tool container removal could not be verified");
  }
}

function isNoSuchContainer(result: DockerCommandResult): boolean {
  return /no such (?:container|object)/i.test(`${result.stderr}\n${result.stdout}`);
}

function isContainerNotRunning(result: DockerCommandResult): boolean {
  return /container\b.*\bis not running\b/i.test(`${result.stderr}\n${result.stdout}`);
}

function deterministicContainerName(...identity: string[]): string {
  const hash = createHash("sha256");
  for (const value of identity) hash.update(String(value.length)).update(":").update(value).update(";");
  return `lite-harness-tool-${hash.digest("hex").slice(0, 32)}`;
}

function labelDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function dockerMaintenanceHardeningArgs(
  config: Pick<DockerRuntimeConfig, "memory" | "cpus" | "pidsLimit">,
  options: { user?: string; capabilities?: readonly string[] } = {},
): string[] {
  const capabilities = options.capabilities ?? [];
  return [
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    ...capabilities.flatMap((capability) => ["--cap-add", capability]),
    "--security-opt", "no-new-privileges=true",
    "--pids-limit", String(config.pidsLimit ?? 64),
    "--memory", config.memory ?? "256m",
    "--cpus", config.cpus ?? "1",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    ...(options.user ? ["--user", options.user] : []),
  ];
}

export function validateArchiveEntries(
  archive: Buffer,
  limits: { maxBytes: number; maxFiles?: number },
): { files: number; payloadBytes: number } {
  const maxFiles = limits.maxFiles ?? 100_000;
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0 ||
      !Number.isSafeInteger(maxFiles) || maxFiles < 1 || archive.length % 512 !== 0) {
    throw new Error("Workspace archive limits or framing are invalid");
  }
  let offset = 0;
  let files = 0;
  let payloadBytes = 0;
  let endBlocks = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      endBlocks += 1;
      if (endBlocks === 2) break;
      continue;
    }
    if (endBlocks > 0) throw new Error("Workspace archive contains data after an end marker");
    verifyTarChecksum(header);
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0);
    if (type !== "0" && type !== "5") throw new Error(`Workspace archive entry type is denied: ${type}`);
    validateArchivePath(path, type === "5");
    if (tarString(header.subarray(157, 257))) throw new Error("Workspace archive links are denied");
    const size = parseTarOctal(header.subarray(124, 136), "size");
    if (type === "5" && size !== 0) throw new Error("Workspace archive directory has a payload");
    files += 1;
    payloadBytes += size;
    if (files > maxFiles || payloadBytes > limits.maxBytes) throw new Error("Workspace archive exceeds file or byte limits");
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > archive.length) throw new Error("Workspace archive entry is truncated");
    offset += padded;
  }
  if (endBlocks < 2 || archive.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error("Workspace archive is missing a canonical end marker");
  }
  return { files, payloadBytes };
}

function verifyTarChecksum(header: Buffer): void {
  const expected = parseTarOctal(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error("Workspace archive header checksum is invalid");
}

function parseTarOctal(field: Buffer, label: string): number {
  const value = field.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`Workspace archive ${label} is invalid`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Workspace archive ${label} is invalid`);
  return parsed;
}

function tarString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function validateArchivePath(path: string, directory: boolean): void {
  const rooted = path.replace(/^\.\//, "");
  const normalized = directory && rooted.endsWith("/") ? rooted.slice(0, -1) : rooted;
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.includes("\\") ||
      /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => !part || part === ".." || part === ".")) {
    if (normalized === "." || normalized === "") return;
    throw new Error("Workspace archive entry path is unsafe");
  }
}

function mountArgs(mount: WorkspaceMount, readOnly = false): string[] {
  const options = [`type=${mount.kind}`, `src=${mount.source}`, "dst=/workspace"];
  if (readOnly) options.push("readonly");
  return ["--mount", options.join(",")];
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
    const context = await runCommand(dockerCommand, ["context", "show"], undefined, undefined, 64 * 1024);
    const info = await runCommand(dockerCommand, ["info", "--format", "{{json .}}"], undefined, undefined, 1024 * 1024);
    let details: { OSType?: string; Architecture?: string; SecurityOptions?: string[] } = {};
    try { details = info.code === 0 ? JSON.parse(info.stdout) as typeof details : {}; } catch { /* retain version health */ }
    return {
      available: result.code === 0 && Boolean(serverVersion),
      ...(clientVersion ? { clientVersion } : {}),
      ...(serverVersion ? { serverVersion } : {}),
      ...(context.code === 0 && context.stdout.trim() ? { activeContext: context.stdout.trim() } : {}),
      ...(details.OSType ? { serverOs: details.OSType } : {}),
      ...(details.Architecture ? { architecture: details.Architecture } : {}),
      ...(details.SecurityOptions ? { rootless: details.SecurityOptions.some((option) => option.toLowerCase().includes("rootless")) } : {}),
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

function boundedStringArgument(call: ToolCall, name: string, maxBytes: number): string {
  const value = stringArgument(call, name);
  if (value.includes("\0") || Buffer.byteLength(value) > maxBytes) throw new Error(`${call.name}.${name} exceeds its byte limit`);
  return value;
}

function optionalBoundedString(value: unknown, name: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function stringArrayArgument(call: ToolCall, name: string, minimum: number, maximum: number): string[] {
  return checkedStringArray(call.arguments[name], `${call.name}.${name}`, minimum, maximum);
}

function optionalStringArray(value: unknown, name: string, maximum: number): string[] {
  return value === undefined ? [] : checkedStringArray(value, name, 0, maximum);
}

function checkedStringArray(value: unknown, name: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${name} has an invalid item count`);
  let bytes = 0;
  const output = value.map((item) => {
    if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > 16_384) throw new Error(`${name} contains an invalid argument`);
    bytes += Buffer.byteLength(item);
    return item;
  });
  if (bytes > 65_536) throw new Error(`${name} exceeds its aggregate byte limit`);
  return output;
}

function workspaceDirectoryArgument(call: ToolCall, name: string): string {
  const value = call.arguments[name];
  if (value === undefined || value === ".") return ".";
  if (typeof value !== "string") throw new Error(`${call.name}.${name} must be a workspace-relative path`);
  validateWorkspacePath(value);
  return value;
}

function optionalWorkspacePaths(value: unknown): string[] {
  const paths = optionalStringArray(value, "paths", 128);
  for (const path of paths) if (path !== ".") validateWorkspacePath(path);
  return paths;
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} is invalid`);
  return value as number;
}

function packageManagerArgument(value: unknown): "pnpm" | "npm" | "yarn" {
  const manager = value ?? "pnpm";
  if (manager !== "pnpm" && manager !== "npm" && manager !== "yarn") throw new Error("Package manager is invalid");
  return manager;
}

function assertAllowedGitSubcommand(value: string): void {
  const allowed = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "add", "commit", "restore", "rm", "mv", "apply"]);
  if (!allowed.has(value)) throw new Error(`Git subcommand is not allowed: ${value}`);
}

function volumeName(workspaceId: string): string {
  const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 24);
  return `lite-harness-ws-${digest}`;
}

function workspaceIdentity(workspaceId: string, principal?: InternalPrincipal): string {
  return principal
    ? `${principal.appId.length}:${principal.appId}:${principal.tenantId.length}:${principal.tenantId}:${principal.userId.length}:${principal.userId}:${workspaceId}`
    : workspaceId;
}

export function dockerWorkspaceVolumeName(workspaceId: string, principal?: InternalPrincipal): string {
  return volumeName(workspaceIdentity(workspaceId, principal));
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
