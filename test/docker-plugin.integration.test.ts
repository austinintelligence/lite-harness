import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawCompatibilityWorker,
  DockerPluginExecutionSandbox,
  inspectPluginManifest,
  LazyPluginSupervisor,
  type InspectedPlugin,
} from "@lite-harness/plugin-core";

const image = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");
const pluginCleanupWaitMs = 40_000;
const roots: string[] = [];
const sandboxes: DockerPluginExecutionSandbox[] = [];

afterEach(async () => {
  await Promise.allSettled(sandboxes.splice(0).map((sandbox) => sandbox.reconcileContainers()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed Docker plugin lifecycle", () => {
  it("A05-PLUGIN-CONTAINER-SECRET-SENTINELS keeps app, provider, integration, root, and IPC sentinels out of the live plugin container", async () => {
    const installationId = uniqueInstallation("a05-secrets");
    const sandbox = managedSandbox(installationId);
    const supervisor = pluginSupervisor(fixturePlugin(`export default {
      invoke(action, input) { return { action, input, isolated: true }; }
    };`), sandbox, { idleTtlMs: 60_000 });
    const suffix = randomUUID();
    const sentinels = [
      `A05_PLUGIN_APP_${suffix}`,
      `A05_PLUGIN_PROVIDER_${suffix}`,
      `A05_PLUGIN_INTEGRATION_${suffix}`,
      `A05_PLUGIN_ROOT_${suffix}`,
      `A05_PLUGIN_IPC_${suffix}`,
    ];
    const env = {
      LITE_A05_PLUGIN_APP_SENTINEL: sentinels[0]!,
      LITE_A05_PLUGIN_PROVIDER_SENTINEL: sentinels[1]!,
      LITE_A05_PLUGIN_INTEGRATION_SENTINEL: sentinels[2]!,
      LITE_A05_PLUGIN_ROOT_SENTINEL: sentinels[3]!,
      LITE_A05_PLUGIN_IPC_SENTINEL: sentinels[4]!,
    };
    const previous = new Map<string, string | undefined>();
    try {
      for (const [name, value] of Object.entries(env)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }
      await expect(supervisor.invoke("echo", { value: "a05" })).resolves.toMatchObject({ isolated: true });
      await waitFor(() => managedContainers(installationId).length === 1, 15_000);
      const container = managedContainers(installationId)[0]!;
      assertNoSentinels(docker(["container", "inspect", container]), sentinels);
      assertNoSentinels(docker(["container", "logs", container]), sentinels);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await supervisor.stop();
      expect(managedContainers(installationId)).toEqual([]);
    }
  }, 90_000);

  it("A22-REAL-PLUGIN-IDLE-ZERO invokes in a managed container and authoritatively reaps it after idle", async () => {
    const installationId = uniqueInstallation("idle");
    const sandbox = managedSandbox(installationId);
    const plugin = fixturePlugin(`export default {
      invoke(action, input) { return { action, input, isolated: true }; }
    };`);
    const supervisor = pluginSupervisor(plugin, sandbox, { idleTtlMs: 75 });
    try {
      await expect(supervisor.invoke("echo", { value: 2 })).resolves.toEqual({ action: "echo", input: { value: 2 }, isolated: true });
      expect(managedContainers(installationId)).toHaveLength(1);
      await waitFor(() => !supervisor.active && managedContainers(installationId).length === 0, pluginCleanupWaitMs);
      expect({ active: supervisor.active, containers: managedContainers(installationId) }).toEqual({ active: false, containers: [] });
    } finally {
      await supervisor.stop();
    }
  }, 90_000);

  it.each([
    ["initialize", `export default { initialize() { throw new Error("fixture initialize failed"); } };`],
    ["health", `export default { health() { throw new Error("fixture health failed"); } };`],
  ])("A22-REAL-PLUGIN-STARTUP-FAILURE-ZERO reaps a container after %s failure", async (_phase, source) => {
    const installationId = uniqueInstallation(`startup-${_phase}`);
    const sandbox = managedSandbox(installationId);
    const supervisor = pluginSupervisor(fixturePlugin(source), sandbox, { idleTtlMs: 0 });
    await expect(supervisor.invoke("echo", {})).rejects.toThrow(/fixture (?:initialize|health) failed/);
    await waitFor(() => managedContainers(installationId).length === 0, pluginCleanupWaitMs);
    expect({ active: supervisor.active, containers: managedContainers(installationId) }).toEqual({ active: false, containers: [] });
  }, 90_000);

  it.each(["hang", "crash"])("A22-REAL-PLUGIN-CHAOS-ZERO reaps the managed container after %s", async (action) => {
    const installationId = uniqueInstallation(action);
    const sandbox = managedSandbox(installationId);
    const plugin = fixturePlugin(`export default {
      invoke(action) {
        if (action === "hang") return new Promise(() => {});
        if (action === "crash") process.exit(23);
        return { ok: true };
      }
    };`);
    const supervisor = pluginSupervisor(plugin, sandbox, { idleTtlMs: 0, rpcTimeoutMs: 750, invocationTimeoutMs: 5_000 });
    await expect(supervisor.invoke(action, {})).rejects.toThrow(action === "hang" ? /timed out/i : /process exited/i);
    await waitFor(() => managedContainers(installationId).length === 0, pluginCleanupWaitMs);
    expect({ active: supervisor.active, containers: managedContainers(installationId) }).toEqual({ active: false, containers: [] });
  }, 90_000);

  it("A08-MANAGER-DEATH-ORPHAN-RECONCILE A22-REAL-PLUGIN-ORPHAN-RECONCILE removes only installation-owned manager-death orphans", async () => {
    const ownedInstallation = uniqueInstallation("orphan-owned");
    const siblingInstallation = uniqueInstallation("orphan-sibling");
    const owned = managedSandbox(ownedInstallation);
    const sibling = managedSandbox(siblingInstallation);
    const ownedName = startDetachedOrphan(ownedInstallation, "owned");
    const siblingName = startDetachedOrphan(siblingInstallation, "sibling");
    expect(containerExists(ownedName)).toBe(true);
    expect(containerExists(siblingName)).toBe(true);

    await expect(owned.reconcileContainers()).resolves.toBe(1);
    expect(containerExists(ownedName)).toBe(false);
    expect(containerExists(siblingName)).toBe(true);
    await expect(sibling.reconcileContainers()).resolves.toBe(1);
    expect(containerExists(siblingName)).toBe(false);
  }, 90_000);
});

function pluginSupervisor(
  plugin: InspectedPlugin,
  sandbox: DockerPluginExecutionSandbox,
  options: { idleTtlMs: number; rpcTimeoutMs?: number; invocationTimeoutMs?: number },
): LazyPluginSupervisor {
  const grants = { tools: ["echo", "hang", "crash"], secrets: [], events: [], files: [], networkOrigins: [] };
  return new LazyPluginSupervisor(
    () => createOpenClawCompatibilityWorker(plugin, grants, {}, {
      sandbox,
      timeoutMs: options.rpcTimeoutMs ?? 30_000,
    }),
    { idleTtlMs: options.idleTtlMs, invocationTimeoutMs: options.invocationTimeoutMs ?? 30_000 },
  );
}

function fixturePlugin(source: string): InspectedPlugin {
  const root = mkdtempSync(join(tmpdir(), "lite-docker-plugin-"));
  roots.push(root);
  // The Docker sandbox deliberately runs as uid 1000. POSIX mkdtemp creates
  // a 0700 directory, which is readable by the host test process but not by
  // that fixed non-root container identity.
  chmodSync(root, 0o755);
  writeFileSync(join(root, "worker.mjs"), `${source}\n`);
  writeFileSync(join(root, "lite-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "example.docker-fixture",
    version: "1.0.0",
    entry: "worker.mjs",
    trust: "isolated",
    permissions: { tools: ["echo", "hang", "crash"], secrets: [], events: [], files: [], networkOrigins: [] },
  }));
  return inspectPluginManifest(join(root, "lite-plugin.json"));
}

function managedSandbox(installationId: string): DockerPluginExecutionSandbox {
  const sandbox = new DockerPluginExecutionSandbox({ image, installationId });
  sandboxes.push(sandbox);
  return sandbox;
}

function startDetachedOrphan(installationId: string, suffix: string): string {
  const name = `lite-harness-plugin-orphan-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  docker([
    "run", "--pull=never", "--detach", "--name", name,
    "--label", "lite-harness.managed=true",
    "--label", "lite-harness.component=plugin",
    "--label", `lite-harness.installation=${labelDigest(installationId)}`,
    "--label", `lite-harness.plugin=${labelDigest(`orphan-${suffix}`)}`,
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    image, "node", "-e", "setInterval(() => {}, 1000)",
  ]);
  return name;
}

function managedContainers(installationId: string): string[] {
  const output = docker([
    "ps", "--all",
    "--filter", "label=lite-harness.managed=true",
    "--filter", "label=lite-harness.component=plugin",
    "--filter", `label=lite-harness.installation=${labelDigest(installationId)}`,
    "--format", "{{.Names}}",
  ]);
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function containerExists(name: string): boolean {
  return spawnSync("docker", ["container", "inspect", name], { stdio: "ignore", windowsHide: true }).status === 0;
}

function docker(args: readonly string[]): string {
  const result = spawnSync("docker", [...args], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker command failed: ${result.stderr || result.stdout}`);
  return result.stdout ?? "";
}

function labelDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function assertNoSentinels(value: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) expect(value).not.toContain(sentinel);
}

function uniqueInstallation(suffix: string): string {
  return `docker-plugin-${suffix}-${randomUUID()}`;
}

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for managed Docker plugin cleanup");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
