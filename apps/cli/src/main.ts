import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OsSecretStore } from "@lite-harness/credential-store";
import { installUserService, uninstallUserService, userServiceStatus } from "@lite-harness/operations";
import { importOpenClawSkills, inspectOpenClawRoot } from "@lite-harness/migration-openclaw";
import {
  PluginInstallLock, PluginPackageInstaller, createOpenClawCompatibilityWorker, inspectPluginManifest,
  pluginPackageDigest,
  type PluginPermissions,
} from "@lite-harness/plugin-core";
import { DockerToolRuntime, inspectDocker } from "@lite-harness/runtime-docker";
import { SQLITE_SCHEMA_VERSION, SqliteRunStore } from "@lite-harness/storage-sqlite";
import { LocalWorkspaceSnapshotStore, StaticSnapshotKeyProvider, validateRegisteredBindRoot } from "@lite-harness/workspace";

const [command = "help", subcommand, argument, extraArgument, fifthArgument] = process.argv.slice(2);
const dataDir = process.env.LITE_HARNESS_DATA_DIR ?? join(process.cwd(), ".lite-harness");

if (command === "doctor") {
  mkdirSync(dataDir, { recursive: true });
  let dataDirectoryWritable = true;
  try { accessSync(dataDir, constants.R_OK | constants.W_OK); } catch { dataDirectoryWritable = false; }
  const docker = await inspectDocker();
  const disk = statfsSync(dataDir);
  const freeBytes = disk.bavail * disk.bsize;
  const database = databaseIntegrityCheck(join(dataDir, "lite-harness.db"));
  const configuredProfile = process.env.LITE_HARNESS_CREDENTIAL_PROFILE ?? `${process.env.LITE_HARNESS_PROVIDER ?? "fake"}_default`;
  let osCredential: { available: boolean; providerConfigured: boolean; snapshotKeyConfigured: boolean; error?: string } = {
    available: true, providerConfigured: false, snapshotKeyConfigured: false,
  };
  try {
    const credentials = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
    osCredential = {
      available: true,
      providerConfigured: Boolean(await credentials.get(configuredProfile)),
      snapshotKeyConfigured: Boolean(await credentials.get("snapshot.root")),
    };
  } catch (error) {
    osCredential = { available: false, providerConfigured: false, snapshotKeyConfigured: false,
      error: error instanceof Error ? error.message : String(error) };
  }
  const environmentSnapshotKey = process.env.LITE_HARNESS_SNAPSHOT_KEY;
  const snapshotKeyValid = environmentSnapshotKey
    ? Buffer.from(environmentSnapshotKey, "base64").length === 32
    : osCredential.snapshotKeyConfigured;
  const runtimeImage = process.env.LITE_HARNESS_RUNTIME_IMAGE;
  const mode = process.env.LITE_HARNESS_MODE ?? "development";
  const runtime = process.env.LITE_HARNESS_RUNTIME ?? "fake";
  const provider = process.env.LITE_HARNESS_PROVIDER ?? "fake";
  const runtimeImageCheck = inspectRuntimeImage(runtimeImage, runtime === "docker" || mode === "production");
  const gateway = await inspectGatewayReadiness(process.env.LITE_HARNESS_DOCTOR_GATEWAY_URL, mode === "production");
  const report = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 24, version: process.versions.node },
    docker,
    dataDirectory: { ok: dataDirectoryWritable, path: dataDir },
    disk: { ok: freeBytes >= 1024 * 1024 * 1024, freeBytes },
    database,
    snapshotKey: { ok: snapshotKeyValid, source: environmentSnapshotKey ? "environment" : osCredential.snapshotKeyConfigured ? "os" : "missing" },
    credentials: {
      osStoreAvailable: osCredential.available,
      providerConfigured: Boolean(process.env.LITE_HARNESS_PROVIDER_API_KEY) || osCredential.providerConfigured || (process.env.LITE_HARNESS_PROVIDER ?? "fake") === "fake",
      ...(osCredential.error ? { error: osCredential.error } : {}),
    },
    runtimeImage: runtimeImageCheck,
    gateway,
    platform: { os: process.platform, arch: process.arch },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const requiredChecks = [
    report.node.ok,
    docker.available,
    docker.serverOs === "linux",
    runtime === "fake" || Boolean(docker.activeContext),
    dataDirectoryWritable,
    report.disk.ok,
    database.ok,
    runtimeImageCheck.ok,
    gateway.ok,
    mode !== "production" || snapshotKeyValid,
    provider === "fake" || report.credentials.providerConfigured,
    mode !== "production" || osCredential.available,
  ];
  process.exitCode = requiredChecks.every(Boolean) ? 0 : 1;
} else if (command === "workspace" && subcommand === "register") {
  if (!argument || !extraArgument) throw new Error("Usage: workspace register <id> <absolute-path>");
  const registeredPath = validateRegisteredBindRoot(extraArgument);
  const database = new SqliteRunStore(join(dataDir, "lite-harness.db"));
  try {
    const now = new Date().toISOString();
    const workspace = database.createWorkspace({
      id: argument,
      appId: requiredEnvironment("LITE_HARNESS_APP_ID"),
      tenantId: requiredEnvironment("LITE_HARNESS_TENANT_ID"),
      userId: requiredEnvironment("LITE_HARNESS_USER_ID"),
      mode: "registered-bind", state: "WARM", registeredPath, createdAt: now, updatedAt: now,
    });
    process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
  } finally { database.close(); }
} else if (command === "workspace" && ["snapshot", "restore", "delete"].includes(subcommand ?? "")) {
  if (!argument) throw new Error("A workspace id is required");
  const runtime = new DockerToolRuntime({ image: requiredEnvironment("LITE_HARNESS_RUNTIME_IMAGE") });
  const principal = {
    appId: requiredEnvironment("LITE_HARNESS_APP_ID"),
    tenantId: requiredEnvironment("LITE_HARNESS_TENANT_ID"),
    userId: requiredEnvironment("LITE_HARNESS_USER_ID"),
    scopes: [],
  };
  if (subcommand === "delete") {
    const removed = await runtime.removeWorkspace(argument, principal);
    process.stdout.write(`${JSON.stringify({ workspaceId: argument, removed })}\n`);
  } else {
    const snapshots = new LocalWorkspaceSnapshotStore(
      join(dataDir, "snapshots"),
      new StaticSnapshotKeyProvider(await snapshotKey()),
    );
    if (subcommand === "snapshot") {
      const record = await snapshots.create(argument, await runtime.exportWorkspace(argument, principal));
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      const restored = await snapshots.restore(argument);
      await runtime.importWorkspace(argument, restored.archive, principal);
      process.stdout.write(`${JSON.stringify({ workspaceId: argument, recoveredFromPrevious: restored.recoveredFromPrevious })}\n`);
    }
  }
} else if (command === "keygen") {
  process.stdout.write(`${randomBytes(32).toString("base64")}\n`);
} else if (command === "keygen-store") {
  const credentials = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
  await credentials.set("snapshot.root", randomBytes(32).toString("base64"));
  await credentials.set("browser.profile-root", randomBytes(32).toString("base64"));
  process.stdout.write(`${JSON.stringify({ profileIds: ["snapshot.root", "browser.profile-root"], configured: true })}\n`);
} else if (command === "credential" && ["set", "status", "delete"].includes(subcommand ?? "")) {
  if (!argument) throw new Error("A credential profile id is required");
  const credentials = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
  if (subcommand === "set") {
    const secret = (await readStandardInput()).replace(/[\r\n]+$/, "");
    if (!secret) throw new Error("Pipe the provider credential to stdin");
    await credentials.set(argument, secret);
    process.stdout.write(`${JSON.stringify({ profileId: argument, configured: true })}\n`);
  } else if (subcommand === "delete") {
    process.stdout.write(`${JSON.stringify({ profileId: argument, deleted: await credentials.delete(argument) })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ profileId: argument, configured: Boolean(await credentials.get(argument)) })}\n`);
  }
} else if (command === "migrate" && subcommand === "openclaw") {
  if (!argument) throw new Error("Usage: migrate openclaw <root> [--apply]");
  const report = inspectOpenClawRoot(argument);
  const importedSkills = extraArgument === "--apply" ? importOpenClawSkills(report, dataDir) : [];
  process.stdout.write(`${JSON.stringify({ mode: extraArgument === "--apply" ? "apply" : "inspect", report, importedSkills }, null, 2)}\n`);
} else if (command === "plugin" && ["inspect", "install", "enable", "disable", "uninstall", "doctor", "migrate"].includes(subcommand ?? "")) {
  const pluginRoot = join(dataDir, "plugins");
  const lock = new PluginInstallLock(join(dataDir, "plugins.lock.json"));
  const installer = new PluginPackageInstaller(pluginRoot, lock);
  if (subcommand === "inspect") {
    if (!argument) throw new Error("Usage: plugin inspect <manifest-path>");
    process.stdout.write(`${JSON.stringify(inspectPluginManifest(argument), null, 2)}\n`);
  } else if (subcommand === "install") {
    if (!argument) throw new Error("Usage: plugin install <package-directory>");
    const installed = await installer.installAndVerify(argument, pluginGrants(), async (plugin, entry) => {
      if (plugin.manifest.trust === "data-only") return;
      const worker = createOpenClawCompatibilityWorker(plugin, entry.grantedPermissions);
      try { await worker.start(); } finally { await worker.stop(); }
    });
    process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`);
  } else if (subcommand === "uninstall") {
    if (!argument || !argument.includes("@")) throw new Error("Usage: plugin uninstall <id>@<version>");
    const separator = argument.lastIndexOf("@");
    process.stdout.write(`${JSON.stringify({ removed: installer.uninstall(argument.slice(0, separator), argument.slice(separator + 1)) })}\n`);
  } else if (subcommand === "enable" || subcommand === "disable") {
    if (!argument || !argument.includes("@")) throw new Error(`Usage: plugin ${subcommand} <id>@<version>`);
    const separator = argument.lastIndexOf("@");
    process.stdout.write(`${JSON.stringify(lock.setEnabled(argument.slice(0, separator), argument.slice(separator + 1), subcommand === "enable"), null, 2)}\n`);
  } else if (subcommand === "migrate") {
    if (!argument || !extraArgument || !fifthArgument) throw new Error("Usage: plugin migrate <package-directory> <from> <to>");
    const plugin = inspectPluginManifest(join(argument, "lite-plugin.json"));
    const worker = createOpenClawCompatibilityWorker(plugin, pluginGrants());
    try {
      await worker.start();
      process.stdout.write(`${JSON.stringify(await worker.migrate(extraArgument, fifthArgument), null, 2)}\n`);
    } finally { await worker.stop(); }
  } else {
    const entries = Object.values(lock.read().plugins);
    const report = entries.map((entry) => {
      try {
        const plugin = inspectPluginManifest(join(entry.source, "lite-plugin.json"));
        return { id: entry.id, version: entry.version, enabled: entry.enabled,
          healthy: plugin.manifest.version === entry.version && pluginPackageDigest(plugin) === entry.digest };
      }
      catch (error) { return { id: entry.id, version: entry.version, enabled: entry.enabled, healthy: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    process.stdout.write(`${JSON.stringify({ ok: report.every((entry) => entry.healthy), plugins: report }, null, 2)}\n`);
  }
} else if (command === "service" && ["install", "status", "uninstall"].includes(subcommand ?? "")) {
  const root = resolve(import.meta.dirname, "../../..");
  const service = { root, dataDir };
  if (subcommand === "install") {
    const credentials = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
    if (!await credentials.get("service.internal-token")) {
      await credentials.set("service.internal-token", randomBytes(32).toString("hex"));
    }
    if (!await credentials.get("service.app-token")) {
      await credentials.set("service.app-token", randomBytes(32).toString("hex"));
    }
    const installed = await installUserService(service);
    process.stdout.write(`${JSON.stringify({ installed: true, path: installed.path })}\n`);
  } else if (subcommand === "uninstall") {
    process.stdout.write(`${JSON.stringify({ removed: await uninstallUserService(service) })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(await userServiceStatus(service))}\n`);
  }
} else {
  process.stdout.write(
    "Lite-Harness\n\nCommands:\n  doctor\n  keygen                       # print a key for headless environments\n  keygen-store                 # generate snapshot.root in the OS store\n  credential set <profile>     # reads secret from stdin\n  credential status <profile>\n  credential delete <profile>\n  migrate openclaw <root> [--apply]\n  plugin inspect <manifest>\n  plugin install <directory>\n  plugin enable|disable <id>@<version>\n  plugin uninstall <id>@<version>\n  plugin migrate <directory> <from> <to>\n  plugin doctor\n  service install|status|uninstall\n  workspace register <id> <absolute-path>\n  workspace snapshot <id>\n  workspace restore <id>\n  workspace delete <id>\n",
  );
}

async function readStandardInput(maxBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > maxBytes) throw new Error(`Standard input exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function databaseIntegrityCheck(path: string): {
  ok: boolean; path: string; integrity: string; foreignKeyViolations: number; migrationVersion: number;
  registeredMounts: Array<{ path: string; ok: boolean; error?: string }>; error?: string;
} {
  if (!existsSync(path)) return {
    ok: true, path, integrity: "not-created", foreignKeyViolations: 0, migrationVersion: 0, registeredMounts: [],
  };
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 2000");
      const row = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
      const integrity = String(Object.values(row)[0] ?? "unknown");
      const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
      const migrationVersion = Number((database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      const registeredMounts = database.prepare("SELECT registered_path FROM workspaces WHERE mode = 'registered-bind'").all()
        .map((item) => String((item as { registered_path: unknown }).registered_path ?? ""))
        .map((registeredPath) => {
          try { validateRegisteredBindRoot(registeredPath); return { path: registeredPath, ok: true }; }
          catch (error) { return { path: registeredPath, ok: false, error: error instanceof Error ? error.message : String(error) }; }
        });
      return {
        ok: integrity === "ok" && foreignKeyViolations === 0 && migrationVersion === SQLITE_SCHEMA_VERSION && registeredMounts.every((item) => item.ok),
        path, integrity, foreignKeyViolations, migrationVersion, registeredMounts,
      };
    } finally { database.close(); }
  } catch (error) {
    return {
      ok: false, path, integrity: "error", foreignKeyViolations: -1, migrationVersion: -1, registeredMounts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectRuntimeImage(image: string | undefined, required: boolean): { ok: boolean; configured: boolean; image?: string; error?: string } {
  if (!image) return { ok: !required, configured: false, ...(required ? { error: "LITE_HARNESS_RUNTIME_IMAGE is required" } : {}) };
  if (!/(?:@sha256:|^sha256:)[a-f0-9]{64}$/.test(image)) return { ok: false, configured: true, image, error: "runtime image is not immutable" };
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 5_000 });
    return { ok: true, configured: true, image };
  } catch (error) {
    return { ok: false, configured: true, image, error: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectGatewayReadiness(url: string | undefined, required: boolean): Promise<{ ok: boolean; configured: boolean; status?: number; error?: string }> {
  if (!url) return { ok: !required, configured: false, ...(required ? { error: "LITE_HARNESS_DOCTOR_GATEWAY_URL is required in production" } : {}) };
  try {
    const base = new URL(url);
    if (!(["127.0.0.1", "::1", "localhost"].includes(base.hostname))) throw new Error("doctor Gateway URL must be loopback-only");
    const response = await fetch(new URL("/readyz", base), { signal: AbortSignal.timeout(5_000) });
    return { ok: response.ok, configured: true, status: response.status, ...(response.ok ? {} : { error: "Gateway or Manager is not ready" }) };
  } catch (error) {
    return { ok: false, configured: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function snapshotKey(): Promise<Buffer> {
  const credentials = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
  const value = process.env.LITE_HARNESS_SNAPSHOT_KEY?.trim() || await credentials.get("snapshot.root");
  if (!value) throw new Error("Configure LITE_HARNESS_SNAPSHOT_KEY or run `pnpm lite keygen-store`");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("LITE_HARNESS_SNAPSHOT_KEY must be a base64-encoded 32-byte key");
  return key;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pluginGrants(): PluginPermissions {
  const raw = process.env.LITE_HARNESS_PLUGIN_GRANTS_JSON;
  if (!raw) return { tools: [], secrets: [], events: [], files: [], networkOrigins: [] };
  const value = JSON.parse(raw) as Partial<PluginPermissions>;
  const list = (field: keyof PluginPermissions) => {
    const items = value[field] ?? [];
    if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) throw new Error(`Plugin grant ${field} is invalid`);
    return items;
  };
  return { tools: list("tools"), secrets: list("secrets"), events: list("events"), files: list("files"), networkOrigins: list("networkOrigins") };
}
