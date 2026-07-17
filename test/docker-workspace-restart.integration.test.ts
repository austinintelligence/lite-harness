import { createHash, randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_BUDGET,
  LITE_IPC_PROTOCOL_VERSION,
  LITE_IPC_VERSION_HEADER,
} from "@lite-harness/contracts";
import { dockerWorkspaceVolumeName } from "@lite-harness/runtime-docker";
import { completeTreeContract } from "./support/complete-tree.js";
import { dockerRestartBlockers, type RunningDockerContainer } from "./support/docker-restart-guard.js";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");
const packagedManager = requiredPackagedManager();
let activeManager: PackagedWorkspaceManager | undefined;

afterEach(async () => {
  await activeManager?.stop().catch(() => undefined);
  activeManager = undefined;
});

describe("packaged Manager workspace durability across restart boundaries", () => {
  it("A09-REAL-RESTART-DURABILITY preserves the complete owner-scoped tree across container, Lite, and Docker restarts", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const dataDir = mkdtempSync(join(tmpdir(), "lite-a09-restart-"));
    const fixture: A09Fixture = {
      owner: { appId: "a09-app", tenantId: "a09-tenant", userId: `a09-user-${suffix}` },
      workspaceId: `a09-workspace-${suffix}`,
      agentId: `a09-shell-${suffix}`,
      internalToken: `a09-real-manager-token-${suffix}`,
    };
    const volume = dockerWorkspaceVolumeName(fixture.workspaceId, { ...fixture.owner, scopes: [] });
    let manager: PackagedWorkspaceManager | undefined;
    const managerPids: number[] = [];
    let testFailure: unknown;

    try {
      expect(namedVolumeExists(volume)).toBe(false);
      manager = await startPackagedManager(dataDir, fixture);
      activeManager = manager;
      managerPids.push(manager.pid);
      expect(manager.pid).not.toBe(process.pid);
      expect(await manager.runShell(seedCompleteTreeScript())).toContain("seeded-a09-tree");
      await waitForNoManagedContainers(dataDir);

      const baseline = completeTreeContract(exportNamedVolume(volume));
      expect(baseline.entries.some((entry) => entry.path === ".lite-harness-workspace")).toBe(false);
      expect(baseline.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ".", type: "5", mode: 0o750, uid: 1000, gid: 1000, mtime: 1_699_999_900 }),
        expect.objectContaining({ path: "empty", type: "5", mode: 0o750, uid: 1000, gid: 1000, mtime: 1_700_000_300 }),
        expect.objectContaining({ path: "nested", type: "5", mode: 0o710, uid: 1000, gid: 1000, mtime: 1_700_000_200 }),
        expect.objectContaining({ path: "nested/deeper", type: "5", mode: 0o700, uid: 1000, gid: 1000, mtime: 1_700_000_100 }),
        expect.objectContaining({
          path: "root.txt", type: "0", mode: 0o640, uid: 1000, gid: 1000,
          size: 12, mtime: 1_700_000_000, contentSha256: sha256("root-payload"),
        }),
        expect.objectContaining({
          path: "nested/deeper/data.json", type: "0", mode: 0o600, uid: 1000, gid: 1000,
          size: 12, mtime: 1_700_000_050, contentSha256: sha256('{"value":42}'),
        }),
      ]));

      await manager.stop();
      activeManager = undefined;
      await waitForNoManagedContainers(dataDir);

      manager = await startPackagedManager(dataDir, fixture);
      activeManager = manager;
      managerPids.push(manager.pid);
      expect(await manager.runShell(readOnlyVerificationScript())).toContain("durable-a09-tree");
      await waitForNoManagedContainers(dataDir);
      expect(completeTreeContract(exportNamedVolume(volume))).toEqual(baseline);

      await manager.stop();
      activeManager = undefined;
      await waitForNoManagedContainers(dataDir);
      expect(new Set(managerPids).size).toBe(2);

      const daemonBefore = dockerDaemonIdentity();
      await restartDockerDaemonFailClosed();
      const daemonAfter = dockerDaemonIdentity();
      expect(daemonAfter).toEqual(daemonBefore);

      manager = await startPackagedManager(dataDir, fixture);
      activeManager = manager;
      managerPids.push(manager.pid);
      expect(await manager.runShell(readOnlyVerificationScript())).toContain("durable-a09-tree");
      await waitForNoManagedContainers(dataDir);
      expect(completeTreeContract(exportNamedVolume(volume))).toEqual(baseline);
      expect(new Set(managerPids).size).toBe(3);
    } catch (error) {
      testFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    let managerStopped = true;
    const cleanupManager = manager ?? activeManager;
    if (cleanupManager) {
      try {
        await cleanupManager.stop();
        if (activeManager === cleanupManager) activeManager = undefined;
      } catch (error) {
        managerStopped = false;
        cleanupFailures.push(error);
      }
    }
    let dockerReady = false;
    try {
      await waitForDockerReady(30_000);
      dockerReady = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (managerStopped && dockerReady) {
      try { removeNamedVolumeIfPresent(volume); } catch (error) { cleanupFailures.push(error); }
    } else if (namedVolumeExistsBestEffort(volume)) {
      cleanupFailures.push(new Error(`A09 cleanup preserved owned volume ${volume} because its Manager or Docker was unavailable`));
    }
    if (managerStopped) {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
    } else {
      cleanupFailures.push(new Error(`A09 cleanup preserved Manager data at ${dataDir} because the process did not stop`));
    }
    if (testFailure && cleanupFailures.length) {
      throw new AggregateError([testFailure, ...cleanupFailures], "A09 qualification and cleanup both failed");
    }
    if (testFailure) throw testFailure;
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "A09 cleanup failed");
    expect(namedVolumeExists(volume)).toBe(false);
  }, 360_000);
});

interface A09Fixture {
  owner: { appId: string; tenantId: string; userId: string };
  workspaceId: string;
  agentId: string;
  internalToken: string;
}

interface RequestResult { status: number; body: unknown }
interface RunRecordResult { id: string; status: string }
interface RunEventResult { type: string; payload: Record<string, unknown> }

class PackagedWorkspaceManager {
  readonly #exit: Promise<void>;
  #logs = "";

  constructor(
    readonly dataDir: string,
    readonly socketPath: string,
    readonly child: ChildProcessWithoutNullStreams,
    readonly fixture: A09Fixture,
  ) {
    this.#exit = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const capture = (chunk: Buffer) => {
      this.#logs = `${this.#logs}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  get pid(): number { return this.child.pid ?? -1; }

  async request(method: string, path: string, body?: unknown): Promise<RequestResult> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return await new Promise<RequestResult>((resolveRequest, rejectRequest) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          [LITE_IPC_VERSION_HEADER]: LITE_IPC_PROTOCOL_VERSION,
          "x-lite-internal-token": this.fixture.internalToken,
          "x-lite-app-id": this.fixture.owner.appId,
          "x-lite-tenant-id": this.fixture.owner.tenantId,
          "x-lite-user-id": this.fixture.owner.userId,
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            request.destroy(new Error("Manager IPC response exceeded 4 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolveRequest({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) as unknown : undefined });
          } catch (error) { rejectRequest(error); }
        });
      });
      request.once("error", rejectRequest);
      if (payload) request.write(payload);
      request.end();
    });
  }

  async initializeFixtures(): Promise<void> {
    const existingAgent = await this.request("GET", `/internal/agents/${this.fixture.agentId}`);
    if (existingAgent.status === 404) {
      const created = await this.request("POST", "/internal/agents", {
        id: this.fixture.agentId,
        name: "A09 restart durability shell",
        instructions: "Invoke the only advertised shell tool exactly once.",
        modelCapabilities: ["text", "tools"],
        allowedTools: ["shell_exec"],
        defaultBudget: { ...DEFAULT_RUN_BUDGET, totalTimeoutMs: 60_000, commandTimeoutMs: 30_000 },
        principal: { ...this.fixture.owner, scopes: [] },
      });
      if (created.status !== 201) throw new Error(`Could not create A09 agent: ${JSON.stringify(created.body)}`);
    } else if (existingAgent.status !== 200) {
      throw new Error(`Could not inspect A09 agent: ${JSON.stringify(existingAgent.body)}`);
    }

    const existingWorkspace = await this.request("GET", `/internal/workspaces/${this.fixture.workspaceId}`);
    if (existingWorkspace.status === 404) {
      const created = await this.request("POST", "/internal/workspaces", {
        id: this.fixture.workspaceId,
        mode: "managed",
        principal: { ...this.fixture.owner, scopes: [] },
      });
      if (created.status !== 201) throw new Error(`Could not create A09 workspace: ${JSON.stringify(created.body)}`);
    } else if (existingWorkspace.status !== 200) {
      throw new Error(`Could not inspect A09 workspace: ${JSON.stringify(existingWorkspace.body)}`);
    }
  }

  async runShell(script: string): Promise<string> {
    const started = await this.request("POST", "/internal/runs", {
      agent: this.fixture.agentId,
      workspace: this.fixture.workspaceId,
      input: JSON.stringify({ script }),
      idempotencyKey: `a09-${randomUUID()}`,
      principal: { ...this.fixture.owner, scopes: ["runs:create"] },
    });
    if (started.status !== 202) throw new Error(`Could not start A09 run: ${JSON.stringify(started.body)}`);
    const runId = (started.body as { runId: string }).runId;
    const terminal = await this.waitForTerminal(runId);
    const eventsResponse = await this.request("GET", `/internal/runs/${runId}/events?after=0&wait_ms=0`);
    if (eventsResponse.status !== 200) throw new Error(`Could not read A09 events: ${JSON.stringify(eventsResponse.body)}`);
    const events = (eventsResponse.body as { events: RunEventResult[] }).events;
    const completion = events.findLast((event) => event.type === "tool.call.completed");
    if (terminal.status !== "SUCCEEDED" || completion?.payload.ok !== true) {
      throw new Error(`A09 shell run failed: terminal=${terminal.status} completion=${JSON.stringify(completion?.payload)}`);
    }
    return typeof completion.payload.content === "string" ? completion.payload.content : "";
  }

  async waitForTerminal(runId: string): Promise<RunRecordResult> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const response = await this.request("GET", `/internal/runs/${runId}`);
      if (response.status !== 200) throw new Error(`Could not read A09 run: ${JSON.stringify(response.body)}`);
      const run = response.body as RunRecordResult;
      if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status)) return run;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for A09 packaged Manager run ${runId}`);
      await delay(50);
    }
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    if (await Promise.race([this.#exit.then(() => true), delay(15_000).then(() => false)])) return;
    this.child.kill("SIGKILL");
    if (!(await Promise.race([this.#exit.then(() => true), delay(10_000).then(() => false)]))) {
      throw new Error(`Packaged Manager did not exit:\n${this.#logs}`);
    }
  }

  failureContext(): string { return this.#logs; }
}

async function startPackagedManager(dataDir: string, fixture: A09Fixture): Promise<PackagedWorkspaceManager> {
  const socketPath = managerSocketPath(dataDir);
  const child = spawn(process.execPath, [packagedManager], {
    cwd: resolve(import.meta.dirname, ".."),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LITE_HARNESS_CONFIG_VERSION: "1",
      LITE_HARNESS_DATA_DIR: dataDir,
      LITE_HARNESS_MANAGER_SOCKET: socketPath,
      LITE_HARNESS_INTERNAL_TOKEN: fixture.internalToken,
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "docker",
      LITE_HARNESS_RUNTIME_IMAGE: image,
      LITE_HARNESS_MODE: "development",
      LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT: "false",
      LITE_HARNESS_SHUTDOWN_TIMEOUT_MS: "10000",
      LITE_HARNESS_SNAPSHOT_KEY: Buffer.alloc(32, 9).toString("base64"),
    },
  });
  const manager = new PackagedWorkspaceManager(dataDir, socketPath, child, fixture);
  activeManager = manager;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Packaged Manager exited during A09 startup:\n${manager.failureContext()}`);
      }
      try {
        const health = await manager.request("GET", "/healthz");
        if (health.status === 200) break;
      } catch { /* local endpoint is not ready yet */ }
      if (Date.now() >= deadline) throw new Error(`Packaged Manager did not become healthy:\n${manager.failureContext()}`);
      await delay(50);
    }
    await manager.initializeFixtures();
    return manager;
  } catch (error) {
    try {
      await manager.stop();
      if (activeManager === manager) activeManager = undefined;
    } catch (stopError) {
      throw new AggregateError([error, stopError], "Packaged Manager startup and cleanup both failed");
    }
    throw error;
  }
}

function exportNamedVolume(volume: string): Buffer {
  const result = spawnSync("docker", [
    "run", "--pull=never", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", "1000:1000",
    "--mount", `type=volume,src=${volume},dst=/workspace,readonly`,
    image, "tar", "-C", "/workspace", "-cf", "-", ".",
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not export A09 workspace volume: ${result.stderr?.toString("utf8") ?? "unknown Docker error"}`);
  }
  return result.stdout;
}

async function restartDockerDaemonFailClosed(): Promise<void> {
  if (process.env.LITE_HARNESS_ALLOW_DOCKER_RESTART?.trim() !== "1") {
    throw new Error("A09 Docker daemon restart is disabled by default; set LITE_HARNESS_ALLOW_DOCKER_RESTART=1 only in an isolated evidence runner");
  }
  const running = listRunningDockerContainers();
  const blockers = dockerRestartBlockers(running);
  if (blockers.length) {
    throw new Error(`A09 refuses to restart a non-quiescent Docker daemon; running containers were detected: ${blockers.map((container) => container.name || container.id).join(", ")}`);
  }
  const adapter = dockerRestartAdapter();
  const epochBefore = adapter.epoch();
  const [command, ...args] = adapter.command;
  const result = spawnSync(command!, args, {
    encoding: "utf8", windowsHide: true, timeout: 240_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Docker restart command failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  await waitForDockerReady(120_000);
  const epochAfter = adapter.epoch();
  if (epochAfter === epochBefore) {
    throw new Error(`Docker ${adapter.kind} restart did not change the active daemon epoch`);
  }
}

function listRunningDockerContainers(): RunningDockerContainer[] {
  const rendered = dockerText(["ps", "--format", "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Labels}}"]);
  return rendered.split(/\\r?\\n/u).filter(Boolean).map((line) => {
    const [id = "", name = "", image = "", labels = ""] = line.split("\\t");
    return { id, name, image, labels };
  });
}

interface DockerRestartAdapter {
  kind: "desktop" | "rootful-systemd" | "rootless-systemd";
  command: string[];
  epoch(): string;
}

function dockerRestartAdapter(): DockerRestartAdapter {
  if (process.env.LITE_HARNESS_DOCKER_RESTART_COMMAND_JSON?.trim()) {
    throw new Error("Opaque Docker restart command overrides cannot produce A09 evidence");
  }
  const endpoint = activeDockerEndpoint();
  if (process.platform !== "linux") {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      throw new Error(`A09 has no Docker Desktop restart adapter for ${process.platform}`);
    }
    const localEndpoint = process.platform === "win32" ? endpoint.startsWith("npipe://") : endpoint.startsWith("unix://");
    const operatingSystem = dockerText(["info", "--format", "{{.OperatingSystem}}"]).trim();
    if (!localEndpoint || !/docker desktop/i.test(operatingSystem)) {
      throw new Error(`A09 refuses to restart Docker Desktop for an unbound active daemon: ${endpoint} (${operatingSystem})`);
    }
    return {
      kind: "desktop",
      command: ["docker", "desktop", "restart", "--timeout", "180"],
      epoch: dockerDesktopSessionId,
    };
  }
  const securityOptions = dockerSecurityOptions();
  const rootless = securityOptions.some((option) => option.toLowerCase().includes("rootless"));
  const uid = process.getuid?.();
  const expectedEndpoints = rootless && uid !== undefined
    ? new Set([`unix:///run/user/${uid}/docker.sock`])
    : new Set(["unix:///var/run/docker.sock", "unix:///run/docker.sock"]);
  if (!expectedEndpoints.has(endpoint)) {
    throw new Error(`A09 refuses to restart a Linux daemon not bound to the canonical ${rootless ? "rootless" : "rootful"} socket: ${endpoint}`);
  }
  return rootless
    ? {
        kind: "rootless-systemd",
        command: ["systemctl", "--user", "restart", "docker"],
        epoch: () => systemdDockerMainPid(true),
      }
    : {
        kind: "rootful-systemd",
        command: ["sudo", "-n", "systemctl", "restart", "docker"],
        epoch: () => systemdDockerMainPid(false),
      };
}

function activeDockerEndpoint(): string {
  const explicitHost = process.env.DOCKER_HOST?.trim();
  if (explicitHost) return explicitHost;
  const contextName = process.env.DOCKER_CONTEXT?.trim() || dockerText(["context", "show"]).trim();
  const rendered = dockerText(["context", "inspect", contextName]);
  let parsed: unknown;
  try { parsed = JSON.parse(rendered) as unknown; } catch {
    throw new Error(`Docker context inspection was not JSON: ${rendered}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : undefined;
  const endpoints = entry && typeof entry === "object" ? (entry as Record<string, unknown>).Endpoints : undefined;
  const docker = endpoints && typeof endpoints === "object" ? (endpoints as Record<string, unknown>).docker : undefined;
  const host = docker && typeof docker === "object" ? (docker as Record<string, unknown>).Host : undefined;
  if (typeof host !== "string" || !host.trim()) {
    throw new Error(`Docker context ${contextName || "unknown"} did not expose an endpoint`);
  }
  return host.trim();
}

function dockerDesktopSessionId(): string {
  const rendered = externalText("docker", ["desktop", "status", "--format", "json"]);
  let parsed: unknown;
  try { parsed = JSON.parse(rendered) as unknown; } catch {
    throw new Error(`Docker Desktop status was not JSON: ${rendered}`);
  }
  if (!parsed || typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).Status !== "running" ||
      typeof (parsed as Record<string, unknown>).SessionID !== "string" ||
      !(parsed as Record<string, string>).SessionID.trim()) {
    throw new Error(`Docker Desktop did not expose a running session epoch: ${rendered}`);
  }
  return (parsed as Record<string, string>).SessionID.trim();
}

function dockerSecurityOptions(): string[] {
  const rendered = dockerText(["info", "--format", "{{json .SecurityOptions}}"]).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(rendered) as unknown; } catch {
    throw new Error(`Docker security options were not JSON: ${rendered}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`Docker security options were invalid: ${rendered}`);
  }
  return parsed as string[];
}

function systemdDockerMainPid(rootless: boolean): string {
  const rendered = externalText("systemctl", [
    ...(rootless ? ["--user"] : []),
    "show", "docker", "--property", "MainPID", "--value",
  ]).trim();
  if (!/^[1-9][0-9]*$/.test(rendered)) {
    throw new Error(`Docker systemd unit did not expose a running MainPID: ${rendered || "empty"}`);
  }
  return rendered;
}

async function waitForDockerReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    if (!result.error && result.status === 0 && result.stdout.trim()) return;
    if (Date.now() >= deadline) throw new Error("Docker daemon did not become ready after restart");
    await delay(500);
  }
}

function dockerDaemonIdentity(): { id: string; version: string; os: string; architecture: string } {
  const rendered = dockerText(["info", "--format", "{{.ID}}|{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}"]).trim();
  const [id, version, os, architecture] = rendered.split("|");
  if (!id || !version || !os || !architecture) throw new Error(`Docker daemon identity was incomplete: ${rendered}`);
  return { id, version, os, architecture };
}

function managedContainers(dataDir: string): string[] {
  return dockerText([
    "ps", "--all",
    "--filter", "label=lite-harness.managed=true",
    "--filter", `label=lite-harness.installation=${labelDigest(dataDir)}`,
    "--format", "{{.Names}}",
  ]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

async function waitForNoManagedContainers(dataDir: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (managedContainers(dataDir).length === 0) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for A09 run-container removal");
    await delay(50);
  }
}

function dockerText(args: string[]): string {
  return externalText("docker", args);
}

function externalText(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} command failed: ${result.stderr || result.stdout || args.join(" ")}`);
  return result.stdout ?? "";
}

function namedVolumeExists(volume: string): boolean {
  const result = spawnSync("docker", ["volume", "inspect", volume], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (/no such volume/i.test(result.stderr ?? "")) return false;
  throw new Error(`Could not inspect A09 workspace volume: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}

function namedVolumeExistsBestEffort(volume: string): boolean {
  try { return namedVolumeExists(volume); } catch { return true; }
}

function removeNamedVolumeIfPresent(volume: string): void {
  if (!namedVolumeExists(volume)) return;
  externalText("docker", ["volume", "rm", volume]);
  if (namedVolumeExists(volume)) throw new Error(`A09 workspace volume remained after removal: ${volume}`);
}

function seedCompleteTreeScript(): string {
  return [
    "set -eu",
    "rm -f .lite-harness-workspace",
    "mkdir -p empty nested/deeper",
    "printf '%s' 'root-payload' > root.txt",
    `printf '%s' '{"value":42}' > nested/deeper/data.json`,
    "chmod 0750 empty",
    "chmod 0710 nested",
    "chmod 0700 nested/deeper",
    "chmod 0640 root.txt",
    "chmod 0600 nested/deeper/data.json",
    "touch -m -d '@1700000000' root.txt",
    "touch -m -d '@1700000050' nested/deeper/data.json",
    "touch -m -d '@1700000100' nested/deeper",
    "touch -m -d '@1700000200' nested",
    "touch -m -d '@1700000300' empty",
    "chmod 0750 .",
    "touch -m -d '@1699999900' .",
    "printf '%s\\n' seeded-a09-tree",
  ].join("\n");
}

function readOnlyVerificationScript(): string {
  return [
    "set -eu",
    "test \"$(cat root.txt)\" = 'root-payload'",
    `test "$(cat nested/deeper/data.json)" = '{"value":42}'`,
    "test -d empty",
    "test ! -e .lite-harness-workspace",
    "printf '%s\\n' durable-a09-tree",
  ].join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function labelDigest(value: string): string {
  return sha256(value).slice(0, 32);
}

function managerSocketPath(dataDir: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\lite-a09-${labelDigest(dataDir)}`
    : join(dataDir, "manager.sock");
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}

function requiredPackagedManager(): string {
  const path = process.env.LITE_HARNESS_PACKAGED_MANAGER?.trim();
  if (!path) throw new Error("LITE_HARNESS_PACKAGED_MANAGER is required; run pnpm build before this real-runtime test");
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`Packaged Manager is missing: ${absolute}`);
  return absolute;
}
