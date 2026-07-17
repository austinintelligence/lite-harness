import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadInstallationConfiguration,
  loadManagerConfiguration,
  loadManagerIpcConfiguration,
  buildRoleEnvironment,
  LITE_INSTALLATION_ENVIRONMENT_KEYS,
  readInstallationConfiguration,
  writeInstallationConfiguration,
} from "@lite-harness/config";
import {
  DEFAULT_RUN_BUDGET,
  isGatewayReadiness,
  LITE_IPC_PROTOCOL_VERSION,
  LITE_IPC_VERSION_HEADER,
  PRODUCTION_READINESS_DEPENDENCY_KEYS,
} from "@lite-harness/contracts";
import { createCredentialStore } from "@lite-harness/credential-store";
import { installUserService, renderUserService, startUserService, stopUserService, uninstallUserService, userServiceStatus } from "@lite-harness/operations";
import { importOpenClawSkills, inspectOpenClawRoot } from "@lite-harness/migration-openclaw";
import type { PluginPermissions } from "@lite-harness/plugin-core";
import { DockerToolRuntime, inspectDocker } from "@lite-harness/runtime-docker";
import { SQLITE_SCHEMA_VERSION, SqliteRunStore } from "@lite-harness/storage-sqlite";
import {
  createInstallationRecoveryBundle,
  DerivedSnapshotKeyProvider,
  LocalWorkspaceSnapshotStore,
  restoreInstallationRecoveryBundle,
  StaticSnapshotKeyProvider,
  validateRegisteredBindRoot,
} from "@lite-harness/workspace";

const [command = "help", subcommand, argument, extraArgument, fifthArgument] = process.argv.slice(2);
const remainingArguments = process.argv.slice(6);
const dataDir = process.env.LITE_HARNESS_DATA_DIR ?? join(process.cwd(), ".lite-harness");
let installedConfiguration: Awaited<ReturnType<typeof readInstallationConfiguration>> | undefined;
try { installedConfiguration = readInstallationConfiguration(dataDir); } catch { /* doctor reports missing/invalid configuration below. */ }
const effectiveEnvironment: NodeJS.ProcessEnv = {
  ...(installedConfiguration?.environment ?? {}),
  ...process.env,
  LITE_HARNESS_DATA_DIR: dataDir,
};

if (command === "help" || command === "--help") {
  process.stdout.write(`Lite-Harness\n\nCommands:\n  init\n  start | stop | status\n  doctor\n  logs [count]\n  config get|set|unset|list|validate\n  token create|list|revoke <id>\n  agent create|list|get|show|delete\n  workspace create|list|get|import|export|delete\n  run start|list|get|show|events|cancel|retry\n  events [watch] <run-id> | cancel <run-id>\n  approve|reject <approval-id>\n  provider list|login|configure|models\n  plugin list|inspect|install|enable|disable|upgrade|rollback\n  integrations list\n  browser doctor\n  prune\n  export|import <workspace-id> [archive-path]\n  recovery export|import <bundle-path> <target-or-key-path> [key-path]\n  gateway | manager\n  migrate openclaw <root> [--apply]\n  service install|status|uninstall\n`);
} else if (command === "doctor") {
  mkdirSync(dataDir, { recursive: true });
  let dataDirectoryWritable = true;
  try { accessSync(dataDir, constants.R_OK | constants.W_OK); } catch { dataDirectoryWritable = false; }
  const docker = await inspectDocker(effectiveEnvironment.LITE_HARNESS_DOCTOR_DOCKER_COMMAND?.trim() || "docker");
  const disk = statfsSync(dataDir);
  const freeBytes = disk.bavail * disk.bsize;
  const minimumFreeBytes = doctorMinimumFreeBytes(process.env.LITE_HARNESS_DOCTOR_MIN_FREE_BYTES);
  const database = databaseIntegrityCheck(join(dataDir, "lite-harness.db"));
  let configuration: { ok: boolean; schemaVersion?: number; dataDir?: string; provider?: string; runtime?: string; mode?: string; error?: string };
  try {
    const validated = loadManagerConfiguration({
      ...effectiveEnvironment,
      LITE_HARNESS_INTERNAL_TOKEN: effectiveEnvironment.LITE_HARNESS_INTERNAL_TOKEN ?? "doctor-validation-internal-token",
    });
    configuration = {
      ok: true, schemaVersion: validated.schemaVersion, dataDir: validated.dataDir,
      provider: validated.provider, runtime: validated.runtime, mode: validated.mode,
    };
  } catch (error) {
    configuration = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const configuredProfile = effectiveEnvironment.LITE_HARNESS_CREDENTIAL_PROFILE ?? `${effectiveEnvironment.LITE_HARNESS_PROVIDER ?? "fake"}_default`;
  let osCredential: { available: boolean; providerConfigured: boolean; snapshotKeyConfigured: boolean; error?: string } = {
    available: true, providerConfigured: false, snapshotKeyConfigured: false,
  };
  try {
    const credentials = createCredentialStore(dataDir, effectiveEnvironment);
    osCredential = {
      available: true,
      providerConfigured: Boolean(await credentials.get(configuredProfile)),
      snapshotKeyConfigured: Boolean(await credentials.get("snapshot.root")),
    };
  } catch (error) {
    osCredential = { available: false, providerConfigured: false, snapshotKeyConfigured: false,
      error: error instanceof Error ? error.message : String(error) };
  }
  const environmentSnapshotKey = effectiveEnvironment.LITE_HARNESS_SNAPSHOT_KEY;
  const snapshotKeyValid = environmentSnapshotKey
    ? validBase64Key(environmentSnapshotKey)
    : osCredential.snapshotKeyConfigured;
  const runtimeImage = effectiveEnvironment.LITE_HARNESS_RUNTIME_IMAGE;
  const mode = effectiveEnvironment.LITE_HARNESS_MODE ?? "development";
  const runtime = effectiveEnvironment.LITE_HARNESS_RUNTIME ?? "fake";
  const provider = effectiveEnvironment.LITE_HARNESS_PROVIDER ?? "fake";
  const runtimeImageCheck = inspectRuntimeImage(runtimeImage, runtime === "docker" || mode === "production");
  const gateway = await inspectGatewayReadiness(process.env.LITE_HARNESS_DOCTOR_GATEWAY_URL, mode === "production");
  const report = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 24, version: process.versions.node },
    docker,
    dataDirectory: { ok: dataDirectoryWritable, path: dataDir },
    disk: { ok: freeBytes >= minimumFreeBytes, freeBytes, requiredFreeBytes: minimumFreeBytes },
    database,
    snapshotKey: { ok: snapshotKeyValid, source: environmentSnapshotKey ? "environment" : osCredential.snapshotKeyConfigured ? "os" : "missing" },
    credentials: {
      osStoreAvailable: osCredential.available,
      providerConfigured: Boolean(effectiveEnvironment.LITE_HARNESS_PROVIDER_API_KEY) || osCredential.providerConfigured || provider === "fake",
      ...(osCredential.error ? { error: osCredential.error } : {}),
    },
    runtimeImage: runtimeImageCheck,
    gateway,
    configuration,
    platform: { os: process.platform, arch: process.arch },
  };
  const remediation = doctorRemediation(report);
  (report as typeof report & { remediation: typeof remediation }).remediation = remediation;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const requiredChecks = [
    report.node.ok,
    !dockerRequired(mode, runtime) || (docker.available && docker.serverOs === "linux" && Boolean(docker.activeContext)),
    dataDirectoryWritable,
    report.disk.ok,
    database.ok,
    configuration.ok,
    runtimeImageCheck.ok,
    gateway.ok,
    mode !== "production" || snapshotKeyValid,
    provider === "fake" || report.credentials.providerConfigured,
    mode !== "production" || osCredential.available,
  ];
  process.exitCode = requiredChecks.every(Boolean) ? 0 : 1;
} else if (command === "init") {
  const installation = loadInstallationConfiguration(process.env, process.cwd(), process.platform, { developmentDefaults: true });
  mkdirSync(installation.dataDir, { recursive: true });
  writeInstallationConfiguration(installation);
  const credentials = createCredentialStore(installation.dataDir, effectiveEnvironment);
  const appCredential = await credentials.getOrCreate("service.app-token", () => `lhr_app_${randomBytes(32).toString("base64url")}`);
  await credentials.getOrCreate("service.internal-token", () => randomBytes(32).toString("hex"));
  await credentials.getOrCreate("snapshot.root", () => randomBytes(32).toString("base64"));
  await credentials.getOrCreate("browser.profile-root", () => randomBytes(32).toString("base64"));
  const appToken = appCredential.value;
  const newClientCredential = appCredential.created;
  const principal = {
    appId: installation.environment.LITE_HARNESS_APP_ID ?? "app_local",
    tenantId: installation.environment.LITE_HARNESS_TENANT_ID ?? "tenant_local",
    userId: installation.environment.LITE_HARNESS_USER_ID ?? "user_local",
  };
  const agentId = installation.environment.LITE_HARNESS_DEFAULT_AGENT_ID ?? "default";
  const workspaceId = installation.environment.LITE_HARNESS_DEFAULT_WORKSPACE_ID ?? "default";
  const database = new SqliteRunStore(join(installation.dataDir, "lite-harness.db"));
  try {
    if (!database.getAgentProfile(agentId, principal)) {
      database.createAgentProfile({
        id: agentId, version: 1, ...principal, name: "Default agent", instructions: "",
        modelCapabilities: ["text", "tools"], allowedTools: ["read_file", "write_file"],
        defaultBudget: DEFAULT_RUN_BUDGET, createdAt: new Date().toISOString(),
      });
    }
    if (!database.getWorkspace(workspaceId, principal)) {
      const now = new Date().toISOString();
      database.createWorkspace({ id: workspaceId, ...principal, mode: "managed", state: "WARM", createdAt: now, updatedAt: now });
    }
  } finally { database.close(); }
  process.stdout.write(`${JSON.stringify({
    initialized: true, dataDir: installation.dataDir, environment: installation.environment,
    owner: principal, defaultAgentId: agentId, defaultWorkspaceId: workspaceId,
    ...(newClientCredential
      ? { clientCredential: appToken, clientCredentialWarning: "Shown once. Store it securely; revoke/rotate it by replacing the service app credential and restarting Gateway." }
      : { clientCredential: null, clientCredentialAlreadyExists: true }),
  }, null, 2)}\n`);
} else if (command === "config" && ["get", "set", "unset", "list", "validate"].includes(subcommand ?? "")) {
  if (subcommand === "validate") {
    try {
      const installation = readInstallationConfiguration(dataDir);
      process.stdout.write(`${JSON.stringify({ valid: true, dataDir: installation.dataDir, environment: installation.environment }, null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ valid: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
      process.exitCode = 1;
    }
  } else {
    const installation = installedConfiguration ?? loadInstallationConfiguration(process.env, process.cwd(), process.platform, { developmentDefaults: true });
    if (subcommand === "list") {
      process.stdout.write(`${JSON.stringify({ dataDir: installation.dataDir, environment: installation.environment }, null, 2)}\n`);
    } else if (subcommand === "get") {
      if (!argument) throw new Error("Usage: config get <LITE_HARNESS_SETTING>");
      if (!(LITE_INSTALLATION_ENVIRONMENT_KEYS as readonly string[]).includes(argument)) throw new Error("Only durable non-secret LITE_HARNESS_* settings can be read");
      process.stdout.write(`${JSON.stringify({ name: argument, value: installation.environment[argument] ?? null })}\n`);
    } else {
      if (!argument || (subcommand === "set" && extraArgument === undefined)) throw new Error(`Usage: config ${subcommand} <LITE_HARNESS_SETTING>${subcommand === "set" ? " <value>" : ""}`);
      if (!(LITE_INSTALLATION_ENVIRONMENT_KEYS as readonly string[]).includes(argument)) throw new Error("Only durable non-secret LITE_HARNESS_* settings can be changed");
      const environment = { ...installation.environment };
      if (subcommand === "set") environment[argument] = extraArgument as string;
      else delete environment[argument];
      const validated = loadInstallationConfiguration({ ...environment, LITE_HARNESS_DATA_DIR: installation.dataDir }, installation.dataDir, process.platform);
      writeInstallationConfiguration(validated);
      process.stdout.write(`${JSON.stringify({ updated: true, name: argument, value: validated.environment[argument] ?? null })}\n`);
    }
  }
} else if (command === "start" || command === "stop" || command === "status") {
  const service = serviceOptions();
  const result = command === "start"
    ? !existsSync(renderUserService({ ...service, platform: process.platform }).path)
      ? { ...(await installUserService(service)), started: true, installed: true }
      : await startUserService(service)
    : command === "stop"
      ? await stopUserService(service)
      : await userServiceStatus(service);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === "logs") {
  const path = join(dataDir, "logs", "lite-harness.jsonl");
  if (!existsSync(path)) {
    process.stdout.write(`${JSON.stringify({ path, lines: [] }, null, 2)}\n`);
  } else {
    const count = argument === undefined ? 100 : Number(argument);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error("logs line count must be between 1 and 10000");
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-count);
    process.stdout.write(`${JSON.stringify({ path, lines }, null, 2)}\n`);
  }
} else if (command === "token" && ["create", "list", "revoke"].includes(subcommand ?? "")) {
  const credentials = createCredentialStore(dataDir, effectiveEnvironment);
  const registry = readTokenRegistry(dataDir);
  if (subcommand === "list") {
    const tokens = [];
    for (const item of registry) tokens.push({ ...item, configured: Boolean(await credentials.get(`token.${item.id}`)) });
    process.stdout.write(`${JSON.stringify({ tokens }, null, 2)}\n`);
  } else {
    if (!argument || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(argument)) throw new Error("Token id must be a bounded identifier");
    if (subcommand === "create") {
      const token = randomBytes(32).toString("base64url");
      await credentials.set(`token.${argument}`, token);
      writeTokenRegistry(dataDir, [...registry.filter((item) => item.id !== argument), { id: argument, createdAt: new Date().toISOString() }]);
      process.stdout.write(`${JSON.stringify({ id: argument, token, warning: "The token is shown once; store it securely." }, null, 2)}\n`);
    } else {
      const deleted = await credentials.delete(`token.${argument}`);
      writeTokenRegistry(dataDir, registry.filter((item) => item.id !== argument));
      process.stdout.write(`${JSON.stringify({ id: argument, revoked: deleted })}\n`);
    }
  }
} else if (command === "agent" && ["create", "list", "get", "show", "delete"].includes(subcommand ?? "")) {
  const principal = cliPrincipal();
  const headers = principalHeaders(principal);
  if (subcommand === "list") {
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", "/internal/agents", undefined, headers), null, 2)}\n`);
  } else if (subcommand === "get" || subcommand === "show") {
    if (!argument) throw new Error(`Usage: agent ${subcommand} <agent-id>`);
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", `/internal/agents/${encodeURIComponent(argument)}`, undefined, headers), null, 2)}\n`);
  } else if (subcommand === "delete") {
    if (!argument) throw new Error("Usage: agent delete <agent-id>");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("DELETE", `/internal/agents/${encodeURIComponent(argument)}`, undefined, headers), null, 2)}\n`);
  } else {
    if (!argument) throw new Error("Usage: agent create <name>");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", "/internal/agents", {
      name: argument, principal,
      ...(process.env.LITE_HARNESS_AGENT_INSTRUCTIONS ? { instructions: process.env.LITE_HARNESS_AGENT_INSTRUCTIONS } : {}),
      ...(process.env.LITE_HARNESS_AGENT_TOOLS_JSON ? { allowedTools: JSON.parse(process.env.LITE_HARNESS_AGENT_TOOLS_JSON) } : {}),
    }, headers), null, 2)}\n`);
  }
} else if ((command === "workspace" && ["create", "list", "get"].includes(subcommand ?? "")) || (command === "workspaces" && subcommand === "list")) {
  const principal = cliPrincipal();
  const headers = principalHeaders(principal);
  if (subcommand === "list") process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", "/internal/workspaces", undefined, headers), null, 2)}\n`);
  else if (subcommand === "get") {
    if (!argument) throw new Error("Usage: workspace get <workspace-id>");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", `/internal/workspaces/${encodeURIComponent(argument)}`, undefined, headers), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", "/internal/workspaces", { ...(argument ? { id: argument } : {}), principal }, headers), null, 2)}\n`);
  }
} else if (command === "run" && ["start", "list", "get", "show", "events", "cancel", "retry"].includes(subcommand ?? "")) {
  const principal = cliPrincipal();
  const headers = principalHeaders(principal);
  if (subcommand === "list") {
    const limit = argument ?? "100";
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1_000) throw new Error("Usage: run list [limit] (1-1000)");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", `/internal/runs?limit=${encodeURIComponent(limit)}`, undefined, headers), null, 2)}\n`);
  } else if (subcommand === "start") {
    if (!argument || !extraArgument) throw new Error("Usage: run start <agent-id> <workspace-id> <input>");
    const input = [fifthArgument, ...remainingArguments].filter((item): item is string => Boolean(item)).join(" ").trim();
    if (!input) throw new Error("Run input is required");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", "/internal/runs", {
      agent: argument, workspace: extraArgument, input, principal,
      session: process.env.LITE_HARNESS_SESSION_ID,
      idempotencyKey: process.env.LITE_HARNESS_IDEMPOTENCY_KEY ?? `cli-${randomBytes(12).toString("hex")}`,
    }, headers), null, 2)}\n`);
  } else {
    if (!argument) throw new Error(`Usage: run ${subcommand} <run-id>`);
    if (subcommand === "get" || subcommand === "show") process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", `/internal/runs/${encodeURIComponent(argument)}`, undefined, headers), null, 2)}\n`);
    else if (subcommand === "events") {
      const after = extraArgument ?? "0";
      const waitMs = fifthArgument ?? "0";
      process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", `/internal/runs/${encodeURIComponent(argument)}/events?after=${encodeURIComponent(after)}&wait_ms=${encodeURIComponent(waitMs)}`, undefined, headers), null, 2)}\n`);
    } else if (subcommand === "cancel") process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", `/internal/runs/${encodeURIComponent(argument)}/cancel`, undefined, headers), null, 2)}\n`);
    else {
      const previous = await managerPluginRequest<{ id: string; agentId: string; workspaceId: string; sessionId?: string; input: string; budget: Record<string, unknown> }>("GET", `/internal/runs/${encodeURIComponent(argument)}`, undefined, headers);
      process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", "/internal/runs", {
        agent: previous.agentId, workspace: previous.workspaceId, ...(previous.sessionId ? { session: previous.sessionId } : {}),
        input: previous.input, budget: previous.budget, principal,
        idempotencyKey: `retry:${previous.id}:${randomBytes(8).toString("hex")}`,
      }, headers), null, 2)}\n`);
    }
  }
} else if ((command === "approve" || command === "reject") && subcommand) {
  process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", `/internal/approvals/${encodeURIComponent(subcommand)}/resolve`, { approved: command === "approve" }, principalHeaders(cliPrincipal())), null, 2)}\n`);
} else if (command === "events") {
  const runId = subcommand === "watch" ? argument : subcommand;
  if (!runId) throw new Error("Usage: events [watch] <run-id> [after] [wait-ms]");
  const after = subcommand === "watch" ? extraArgument ?? "0" : argument ?? "0";
  const waitMs = subcommand === "watch" ? fifthArgument ?? "0" : extraArgument ?? "0";
  process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", `/internal/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}&wait_ms=${encodeURIComponent(waitMs)}`, undefined, principalHeaders(cliPrincipal())), null, 2)}\n`);
} else if (command === "cancel" && subcommand) {
  process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", `/internal/runs/${encodeURIComponent(subcommand)}/cancel`, undefined, principalHeaders(cliPrincipal())), null, 2)}\n`);
} else if ((command === "providers" || command === "provider") && ["list", "login", "configure", "models"].includes(subcommand ?? "")) {
  if (subcommand === "list") {
    process.stdout.write(`${JSON.stringify({ selected: effectiveEnvironment.LITE_HARNESS_PROVIDER ?? "fake", credentialStore: effectiveEnvironment.LITE_HARNESS_CREDENTIAL_STORE ?? "environment", providers: ["fake", "openai", "openai-compatible", "anthropic", "codex", "claude"] }, null, 2)}\n`);
  } else if (subcommand === "models") {
    let catalog: unknown[] = [];
    if (effectiveEnvironment.LITE_HARNESS_MODEL_CATALOG) {
      try { catalog = JSON.parse(effectiveEnvironment.LITE_HARNESS_MODEL_CATALOG) as unknown[]; } catch { throw new Error("LITE_HARNESS_MODEL_CATALOG is invalid JSON"); }
    }
    process.stdout.write(`${JSON.stringify({ selected: effectiveEnvironment.LITE_HARNESS_MODEL ?? null, models: catalog }, null, 2)}\n`);
  } else if (subcommand === "login") {
    if (!argument) throw new Error("Usage: providers login <id>");
    const secret = (await readStandardInput()).replace(/[\r\n]+$/, "");
    if (!secret) throw new Error("Pipe the provider credential to stdin");
    await createCredentialStore(dataDir, effectiveEnvironment).set(`${argument}_default`, secret);
    process.stdout.write(`${JSON.stringify({ provider: argument, profileId: `${argument}_default`, configured: true })}\n`);
  } else {
    if (!argument) throw new Error("Usage: providers configure <id> [base-url] [model]");
    const updates: Record<string, string> = { LITE_HARNESS_PROVIDER: argument };
    if (extraArgument) updates.LITE_HARNESS_PROVIDER_BASE_URL = extraArgument;
    if (fifthArgument) updates.LITE_HARNESS_MODEL = fifthArgument;
    const validated = persistConfigurationPatch(updates);
    process.stdout.write(`${JSON.stringify({ configured: true, environment: validated.environment }, null, 2)}\n`);
  }
} else if (command === "models" && subcommand === "list") {
  let catalog: unknown[] = [];
  if (effectiveEnvironment.LITE_HARNESS_MODEL_CATALOG) {
    try { catalog = JSON.parse(effectiveEnvironment.LITE_HARNESS_MODEL_CATALOG) as unknown[]; } catch { throw new Error("LITE_HARNESS_MODEL_CATALOG is invalid JSON"); }
  }
  process.stdout.write(`${JSON.stringify({ selected: effectiveEnvironment.LITE_HARNESS_MODEL ?? null, models: catalog }, null, 2)}\n`);
} else if ((command === "plugins" || command === "plugin") && subcommand === "list") {
  process.stdout.write(`${JSON.stringify(await managerPluginRequest("GET", "/internal/plugins"), null, 2)}\n`);
} else if (command === "integrations" && subcommand === "list") {
  process.stdout.write(`${JSON.stringify({ integrations: effectiveEnvironment.LITE_HARNESS_WEBHOOK_ACCOUNT ? [{ kind: "webhook", accountId: effectiveEnvironment.LITE_HARNESS_WEBHOOK_ACCOUNT }] : [] }, null, 2)}\n`);
} else if (command === "browser" && subcommand === "doctor") {
  process.stdout.write(`${JSON.stringify({ configuredImage: effectiveEnvironment.LITE_HARNESS_BROWSER_IMAGE ?? null, privateNetworksAllowed: effectiveEnvironment.LITE_HARNESS_BROWSER_ALLOW_PRIVATE === "true", status: "configuration-only" }, null, 2)}\n`);
} else if (command === "prune") {
  process.stdout.write(`${JSON.stringify({ pruned: [], status: "manager-gc-required", message: "No destructive prune was performed; Manager-owned snapshot/cache GC must be active." })}\n`);
} else if (command === "recovery" && subcommand === "export") {
  if (!argument || !extraArgument) throw new Error("Usage: recovery export <bundle-path> <recovery-key-file>");
  const recoveryKey = readRecoveryKey(extraArgument);
  writeFileSync(argument, createInstallationRecoveryBundle(dataDir, recoveryKey), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ exported: true, path: resolve(argument), source: resolve(dataDir), encrypted: true })}\n`);
} else if (command === "recovery" && subcommand === "import") {
  if (!argument || !extraArgument || !fifthArgument) throw new Error("Usage: recovery import <bundle-path> <target-data-dir> <recovery-key-file>");
  const recoveryKey = readRecoveryKey(fifthArgument);
  const restored = restoreInstallationRecoveryBundle(readFileSync(argument), recoveryKey, extraArgument);
  process.stdout.write(`${JSON.stringify({ imported: true, path: resolve(argument), target: resolve(extraArgument), bundleId: restored.bundleId, entries: restored.restoredPaths.length })}\n`);
} else if ((command === "export" && subcommand) || (command === "workspace" && subcommand === "export" && argument)) {
  const runtime = new DockerToolRuntime({ image: requiredEnvironment("LITE_HARNESS_RUNTIME_IMAGE") });
  const workspaceId = command === "workspace" ? argument! : subcommand!;
  const archivePath = command === "workspace" ? extraArgument ?? `${workspaceId}.tar` : argument ?? `${workspaceId}.tar`;
  writeFileSync(archivePath, await runtime.exportWorkspace(workspaceId, cliPrincipal()));
  process.stdout.write(`${JSON.stringify({ workspaceId, path: resolve(archivePath), exported: true })}\n`);
} else if ((command === "import" && subcommand) || (command === "workspace" && subcommand === "import" && argument)) {
  const runtime = new DockerToolRuntime({ image: requiredEnvironment("LITE_HARNESS_RUNTIME_IMAGE") });
  const workspaceId = command === "workspace" ? argument! : subcommand!;
  const archivePath = command === "workspace" ? extraArgument ?? `${workspaceId}.tar` : argument ?? `${workspaceId}.tar`;
  await runtime.importWorkspace(workspaceId, readFileSync(archivePath), cliPrincipal());
  process.stdout.write(`${JSON.stringify({ workspaceId, path: resolve(archivePath), imported: true })}\n`);
} else if (command === "gateway" || command === "manager") {
  const installation = installedConfiguration ?? loadInstallationConfiguration(process.env, process.cwd(), process.platform, { developmentDefaults: true });
  const credentials = createCredentialStore(installation.dataDir, effectiveEnvironment);
  const internalToken = effectiveEnvironment.LITE_HARNESS_INTERNAL_TOKEN ?? await credentials.get("service.internal-token");
  const appToken = effectiveEnvironment.LITE_HARNESS_APP_TOKEN ?? await credentials.get("service.app-token");
  if (!internalToken || (command === "gateway" && !appToken)) throw new Error("Installed service tokens are missing; run `pnpm lite init` then `pnpm lite service install`");
  const roleEnvironment = buildRoleEnvironment(command, installation, effectiveEnvironment, {
    LITE_HARNESS_INTERNAL_TOKEN: internalToken,
    ...(appToken ? { LITE_HARNESS_APP_TOKEN: appToken } : {}),
  });
  const entry = join(resolve(import.meta.dirname, "../../.."), "apps", command, "src", "main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: resolve(import.meta.dirname, "../../.."), env: roleEnvironment, stdio: "inherit", windowsHide: true });
  await new Promise<void>((resolveProcess, rejectProcess) => { child.once("error", rejectProcess); child.once("exit", () => resolveProcess()); });
  process.exitCode = child.exitCode ?? 1;
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
    const rootKey = await snapshotKey();
    const snapshots = new LocalWorkspaceSnapshotStore(
      join(dataDir, "snapshots"),
      new DerivedSnapshotKeyProvider(rootKey),
      new StaticSnapshotKeyProvider(rootKey),
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
  const credentials = createCredentialStore(dataDir, effectiveEnvironment);
  await credentials.set("snapshot.root", randomBytes(32).toString("base64"));
  await credentials.set("browser.profile-root", randomBytes(32).toString("base64"));
  process.stdout.write(`${JSON.stringify({ profileIds: ["snapshot.root", "browser.profile-root"], configured: true })}\n`);
} else if (command === "credential" && ["set", "status", "delete"].includes(subcommand ?? "")) {
  if (!argument) throw new Error("A credential profile id is required");
  const credentials = createCredentialStore(dataDir, effectiveEnvironment);
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
} else if (command === "plugin" && ["inspect", "install", "list", "enable", "disable", "uninstall", "doctor", "migrate", "upgrade", "rollback"].includes(subcommand ?? "")) {
  if (subcommand === "inspect") {
    if (!argument) throw new Error("Usage: plugin inspect <manifest-path>");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", "/internal/plugins/inspect", { path: argument }), null, 2)}\n`);
  } else if (subcommand === "install") {
    if (!argument) throw new Error("Usage: plugin install <package-directory>");
    const installed = await managerPluginRequest("POST", "/internal/plugins/install", {
      sourceRoot: argument, grant: pluginGrants(),
    });
    process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`);
  } else if (subcommand === "uninstall") {
    const coordinate = pluginCoordinate(argument, "uninstall");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest(
      "DELETE", `/internal/plugins/${encodeURIComponent(coordinate.id)}/${encodeURIComponent(coordinate.version)}`,
    ))}\n`);
  } else if (subcommand === "enable" || subcommand === "disable") {
    const coordinate = pluginCoordinate(argument, subcommand);
    const path = subcommand === "enable"
      ? `/internal/plugins/${encodeURIComponent(coordinate.id)}/${encodeURIComponent(coordinate.version)}/enable`
      : `/internal/plugins/${encodeURIComponent(coordinate.id)}/${encodeURIComponent(coordinate.version)}/disable`;
    process.stdout.write(`${JSON.stringify(await managerPluginRequest("POST", path), null, 2)}\n`);
  } else if (subcommand === "migrate" || subcommand === "upgrade") {
    if (!argument || !extraArgument || !fifthArgument) throw new Error(`Usage: plugin ${subcommand} <package-directory> <from> <to>`);
    const inspection = await managerPluginRequest<{ manifest: { id: string; version: string } }>(
      "POST", "/internal/plugins/inspect", { path: argument },
    );
    if (inspection.manifest.version !== fifthArgument) throw new Error("Plugin migrate target does not match the package version");
    const status = await managerPluginRequest<{ active: Array<{ id: string; version: string }> }>("GET", "/internal/plugins");
    if (!status.active.some((entry) => entry.id === inspection.manifest.id && entry.version === extraArgument)) {
      throw new Error(`Plugin migrate source is not the active generation: ${inspection.manifest.id}@${extraArgument}`);
    }
    process.stdout.write(`${JSON.stringify(await managerPluginRequest(
      "POST", `/internal/plugins/${encodeURIComponent(inspection.manifest.id)}/upgrade`,
      { sourceRoot: argument, grant: pluginGrants() },
    ), null, 2)}\n`);
  } else if (subcommand === "rollback") {
    if (!argument) throw new Error("Usage: plugin rollback <id>");
    process.stdout.write(`${JSON.stringify(await managerPluginRequest(
      "POST", `/internal/plugins/${encodeURIComponent(argument)}/rollback`,
    ), null, 2)}\n`);
  } else {
    const status = await managerPluginRequest<{ plugins: Array<{ healthy: boolean; cleanupDebt?: unknown }> }>("GET", "/internal/plugins");
    process.stdout.write(`${JSON.stringify({
      ok: status.plugins.every((entry) => entry.healthy && !entry.cleanupDebt),
      ...status,
    }, null, 2)}\n`);
  }
} else if (command === "service" && ["install", "status", "uninstall"].includes(subcommand ?? "")) {
  const root = resolve(import.meta.dirname, "../../..");
  if (subcommand === "install") {
    const installation = loadInstallationConfiguration(process.env, process.cwd(), process.platform, { developmentDefaults: true });
    const service = { root, dataDir: installation.dataDir };
    const credentials = createCredentialStore(installation.dataDir, effectiveEnvironment);
    await credentials.getOrCreate("service.internal-token", () => randomBytes(32).toString("hex"));
    await credentials.getOrCreate("service.app-token", () => randomBytes(32).toString("hex"));
    writeInstallationConfiguration(installation);
    const installed = await installUserService(service);
    process.stdout.write(`${JSON.stringify({ installed: true, path: installed.path })}\n`);
  } else if (subcommand === "uninstall") {
    const service = { root, dataDir: installedConfiguration?.dataDir ?? dataDir };
    process.stdout.write(`${JSON.stringify({ removed: await uninstallUserService(service) })}\n`);
  } else {
    const service = { root, dataDir: installedConfiguration?.dataDir ?? dataDir };
    process.stdout.write(`${JSON.stringify(await userServiceStatus(service))}\n`);
  }
} else {
  process.stdout.write(
    "Lite-Harness\n\nCommands:\n  init\n  start | stop | status\n  doctor\n  logs [count]\n  config get|set|unset|list|validate\n  token create|list|revoke <id>\n  keygen                       # print a key for headless environments\n  keygen-store                 # generate snapshot.root in the OS store\n  credential set <profile>     # reads secret from stdin\n  credential status <profile>\n  credential delete <profile>\n  agent create|list|get\n  workspace create|list|get\n  workspace register <id> <absolute-path>\n  workspace snapshot <id>\n  workspace restore <id>\n  workspace delete <id>\n  workspaces list\n  run start|list|get|events|cancel|retry\n  approve|reject <approval-id>\n  events|cancel <run-id>\n  providers list|login|configure\n  models list\n  plugins list\n  integrations list\n  browser doctor\n  prune\n  export|import <workspace-id> [archive-path]\n  recovery export|import <bundle-path> <target-or-key-path> [key-path]\n  gateway | manager\n  migrate openclaw <root> [--apply]\n  plugin inspect <manifest>\n  plugin install <directory>\n  plugin enable|disable <id>@<version>\n  plugin uninstall <id>@<version>\n  plugin migrate <directory> <from> <to>\n  plugin rollback <id>\n  plugin doctor\n  service install|status|uninstall\n",
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

function doctorMinimumFreeBytes(value: string | undefined): number {
  if (value === undefined) return 1024 * 1024 * 1024;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return Number.MAX_SAFE_INTEGER;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function validBase64Key(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const key = Buffer.from(value, "base64");
  return key.length === 32 && key.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "");
}

function doctorRemediation(report: {
  node: { ok: boolean };
  docker: { available: boolean; serverOs?: string; activeContext?: string };
  dataDirectory: { ok: boolean };
  disk: { ok: boolean };
  database: { ok: boolean };
  snapshotKey: { ok: boolean };
  credentials: { osStoreAvailable: boolean; providerConfigured: boolean };
  runtimeImage: { ok: boolean };
  gateway: { ok: boolean };
  configuration: { ok: boolean; mode?: string; provider?: string; runtime?: string };
}): Array<{ check: string; remediation: string }> {
  const remediation: Array<{ check: string; remediation: string }> = [];
  if (!report.node.ok) remediation.push({ check: "node", remediation: "Install the pinned Node 24 runtime." });
  if (!report.configuration.ok) remediation.push({ check: "configuration", remediation: "Fix the reported LITE_HARNESS_* configuration and rerun doctor." });
  if (dockerRequired(report.configuration.mode, report.configuration.runtime) &&
      (!report.docker.available || report.docker.serverOs !== "linux" || !report.docker.activeContext)) {
    remediation.push({ check: "docker", remediation: "Start a Linux Docker engine and verify the active context and server version." });
  }
  if (!report.dataDirectory.ok) remediation.push({ check: "dataDirectory", remediation: "Grant the service account read/write access to the data directory." });
  if (!report.disk.ok) remediation.push({ check: "disk", remediation: "Free disk space or move LITE_HARNESS_DATA_DIR to a volume with the required reserve." });
  if (!report.database.ok) remediation.push({ check: "database", remediation: "Restore from the previous-good database or run the ordered migration repair workflow." });
  if (report.configuration.mode === "production" && !report.snapshotKey.ok) remediation.push({ check: "snapshotKey", remediation: "Configure a valid base64-encoded 32-byte snapshot key in the OS store or environment." });
  const requiresProviderCredential = report.configuration.ok && report.configuration.provider !== "fake";
  const requiresOsCredentialStore = report.configuration.ok && report.configuration.mode === "production";
  if ((requiresProviderCredential && !report.credentials.providerConfigured) ||
      (requiresOsCredentialStore && !report.credentials.osStoreAvailable)) {
    remediation.push({ check: "credentials", remediation: "Configure the OS credential store and the selected provider profile." });
  }
  if (!report.runtimeImage.ok) remediation.push({ check: "runtimeImage", remediation: "Install the exact digest-pinned runtime image." });
  if (!report.gateway.ok) remediation.push({ check: "gateway", remediation: "Start Gateway and Manager locally, then verify loopback /readyz health." });
  return remediation;
}

function dockerRequired(mode: string | undefined, runtime: string | undefined): boolean {
  return mode === "production" || runtime === "docker";
}

async function inspectGatewayReadiness(url: string | undefined, required: boolean): Promise<{ ok: boolean; configured: boolean; status?: number; error?: string }> {
  if (!url) return { ok: !required, configured: false, ...(required ? { error: "LITE_HARNESS_DOCTOR_GATEWAY_URL is required in production" } : {}) };
  try {
    const base = new URL(url);
    if (!(["127.0.0.1", "::1", "localhost"].includes(base.hostname))) throw new Error("doctor Gateway URL must be loopback-only");
    const response = await fetch(new URL("/readyz", base), { signal: AbortSignal.timeout(5_000) });
    const body = await response.json() as unknown;
    if (!isGatewayReadiness(body)) {
      return { ok: false, configured: true, status: response.status, error: "Gateway readiness response does not match the public contract" };
    }
    const manager = body.dependencies.manager;
    const dependenciesHealthy = Object.values(manager.dependencies).every((dependency) => dependency.ok);
    const dependenciesComplete = PRODUCTION_READINESS_DEPENDENCY_KEYS.every(
      (name) => manager.dependencies[name]?.ok === true,
    );
    const aggregatesConsistent = body.ok === manager.ok && manager.ok === dependenciesHealthy;
    const ok = response.ok && body.ok && manager.ok && aggregatesConsistent && dependenciesComplete &&
      manager.protocolVersion === LITE_IPC_PROTOCOL_VERSION;
    return { ok, configured: true, status: response.status, ...(ok ? {} : { error: "Gateway or Manager is not ready or IPC-compatible" }) };
  } catch (error) {
    return { ok: false, configured: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function snapshotKey(): Promise<Buffer> {
  const credentials = createCredentialStore(dataDir, effectiveEnvironment);
  const value = effectiveEnvironment.LITE_HARNESS_SNAPSHOT_KEY?.trim() || await credentials.get("snapshot.root");
  if (!value) throw new Error("Configure LITE_HARNESS_SNAPSHOT_KEY or run `pnpm lite keygen-store`");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("LITE_HARNESS_SNAPSHOT_KEY must be a base64-encoded 32-byte key");
  return key;
}

function requiredEnvironment(name: string): string {
  const value = effectiveEnvironment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readRecoveryKey(path: string): Buffer {
  const raw = readFileSync(path, "utf8").trim();
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("Recovery key file must contain exactly 32 bytes as hex or base64");
  return key;
}

function cliPrincipal(): { appId: string; tenantId: string; userId: string; scopes: string[] } {
  return {
    appId: effectiveEnvironment.LITE_HARNESS_APP_ID?.trim() || "app_local",
    tenantId: effectiveEnvironment.LITE_HARNESS_TENANT_ID?.trim() || "tenant_local",
    userId: effectiveEnvironment.LITE_HARNESS_USER_ID?.trim() || "user_local",
    scopes: [],
  };
}

function principalHeaders(principal: { appId: string; tenantId: string; userId: string }): Record<string, string> {
  return {
    "x-lite-app-id": principal.appId,
    "x-lite-tenant-id": principal.tenantId,
    "x-lite-user-id": principal.userId,
  };
}

function serviceOptions(): { root: string; dataDir: string } {
  return { root: resolve(import.meta.dirname, "../../.."), dataDir: installedConfiguration?.dataDir ?? dataDir };
}

function persistConfigurationPatch(updates: Record<string, string>): Awaited<ReturnType<typeof loadInstallationConfiguration>> {
  const installation = installedConfiguration ?? loadInstallationConfiguration(process.env, process.cwd(), process.platform, { developmentDefaults: true });
  for (const name of Object.keys(updates)) {
    if (!(LITE_INSTALLATION_ENVIRONMENT_KEYS as readonly string[]).includes(name)) throw new Error(`Configuration setting is not durable or is secret: ${name}`);
  }
  const validated = loadInstallationConfiguration({
    ...installation.environment,
    ...updates,
    LITE_HARNESS_DATA_DIR: installation.dataDir,
  }, installation.dataDir, process.platform);
  writeInstallationConfiguration(validated);
  return validated;
}

type TokenMetadata = { id: string; createdAt: string };

function readTokenRegistry(root: string): TokenMetadata[] {
  const path = join(root, "token-registry.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => item && typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" && typeof (item as { createdAt?: unknown }).createdAt === "string")) {
    throw new Error("Token registry is malformed");
  }
  return parsed as TokenMetadata[];
}

function writeTokenRegistry(root: string, entries: TokenMetadata[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "token-registry.json"), `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function pluginCoordinate(value: string | undefined, operation: string): { id: string; version: string } {
  if (!value || !value.includes("@")) throw new Error(`Usage: plugin ${operation} <id>@<version>`);
  const separator = value.lastIndexOf("@");
  const id = value.slice(0, separator);
  const version = value.slice(separator + 1);
  if (!id || !version) throw new Error(`Usage: plugin ${operation} <id>@<version>`);
  return { id, version };
}

async function managerPluginRequest<T = unknown>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const configuration = loadManagerIpcConfiguration(effectiveEnvironment);
  const credentials = createCredentialStore(configuration.dataDir, effectiveEnvironment);
  const internalToken = effectiveEnvironment.LITE_HARNESS_INTERNAL_TOKEN?.trim() || await credentials.get("service.internal-token");
  if (!internalToken) throw new Error("Manager plugin commands require LITE_HARNESS_INTERNAL_TOKEN or an installed service token");
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  return await new Promise<T>((resolveRequest, rejectRequest) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const request = httpRequest({
      socketPath: configuration.socketPath,
      path,
      method,
      headers: {
        [LITE_IPC_VERSION_HEADER]: LITE_IPC_PROTOCOL_VERSION,
        "x-lite-internal-token": internalToken,
        ...extraHeaders,
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          request.destroy(new Error("Manager plugin response exceeds 4 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => settle(() => rejectRequest(error)));
      response.once("end", () => {
        settle(() => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const parsed = text ? JSON.parse(text) as unknown : {};
            if ((response.statusCode ?? 500) >= 400) {
              const error = parsed && typeof parsed === "object" ? (parsed as { error?: { message?: unknown } }).error : undefined;
              throw new Error(typeof error?.message === "string" ? error.message : `Manager plugin request failed with HTTP ${response.statusCode}`);
            }
            resolveRequest(parsed as T);
          } catch (error) { rejectRequest(error); }
        });
      });
    });
    request.setTimeout(120_000, () => request.destroy(new Error("Manager plugin request timed out")));
    request.once("error", (error) => settle(() => rejectRequest(error)));
    if (payload) request.end(payload); else request.end();
  });
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
