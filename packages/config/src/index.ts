import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isLoopbackHttpUrl } from "@lite-harness/contracts";

export const LITE_CONFIG_SCHEMA_VERSION = 1 as const;
export const LITE_INSTALLATION_CONFIGURATION_FILE = "installation.json";

export const LITE_INSTALLATION_ENVIRONMENT_KEYS = [
  "LITE_HARNESS_CONFIG_VERSION", "LITE_HARNESS_MANAGER_SOCKET",
  "LITE_HARNESS_PROVIDER", "LITE_HARNESS_PROVIDER_BASE_URL", "LITE_HARNESS_MODEL",
  "LITE_HARNESS_MODEL_CATALOG", "LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION",
  "LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION", "LITE_HARNESS_RUNTIME",
  "LITE_HARNESS_RUNTIME_IMAGE", "LITE_HARNESS_MODE", "LITE_HARNESS_OFFLINE",
  "LITE_HARNESS_APPROVAL_TIMEOUT_MS", "LITE_HARNESS_SHUTDOWN_TIMEOUT_MS",
  "LITE_HARNESS_WORKSPACE_QUOTA_BYTES", "LITE_HARNESS_BROWSER_IDLE_MS",
  "LITE_HARNESS_MODEL_CONTEXT", "LITE_HARNESS_DELEGATED_MAX_BUDGET_USD",
  "LITE_HARNESS_RUNTIME_MEMORY", "LITE_HARNESS_RUNTIME_CPUS", "LITE_HARNESS_RUNTIME_PIDS",
  "LITE_HARNESS_ENABLE_MEMORY", "LITE_HARNESS_REQUIRE_APPROVALS",
  "LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT", "LITE_HARNESS_BROWSER_ALLOW_PRIVATE",
  "LITE_HARNESS_CONTEXT_OPTIMIZATION", "LITE_HARNESS_ENABLE_PLUGINS",
  "LITE_HARNESS_ENABLE_CACHE_CATALOG", "LITE_HARNESS_CREDENTIAL_PROFILE",
  "LITE_HARNESS_CREDENTIAL_STORE", "LITE_HARNESS_TOOL_PROFILE",
  "LITE_HARNESS_CONTEXT_FILE", "LITE_HARNESS_CONTEXT_KIND", "LITE_HARNESS_CONTEXT_ALLOWED_APPS",
  "LITE_HARNESS_CONTEXT_ALLOWED_MODELS", "LITE_HARNESS_CONTEXT_KILLED_APPS", "LITE_HARNESS_CONTEXT_KILLED_MODELS",
  "LITE_HARNESS_SKILL_ROOTS", "LITE_HARNESS_SKILL_CAPABILITIES", "LITE_HARNESS_MCP_SERVERS",
  "LITE_HARNESS_PLUGIN_IMAGE", "LITE_HARNESS_PLUGIN_IDLE_MS", "LITE_HARNESS_PLUGIN_RPC_TIMEOUT_MS",
  "LITE_HARNESS_PLUGIN_INVOCATION_TIMEOUT_MS", "LITE_HARNESS_PLUGIN_CLEANUP_RETRY_MS",
  "LITE_HARNESS_PLUGIN_CLEANUP_ATTEMPTS", "LITE_HARNESS_PLUGIN_CLEANUP_TIMEOUT_MS",
  "LITE_HARNESS_PLUGIN_CRASH_BACKOFF_BASE_MS", "LITE_HARNESS_PLUGIN_CRASH_BACKOFF_MAX_MS",
  "LITE_HARNESS_MEMORY_CONTEXT_ENTRIES", "LITE_HARNESS_MEMORY_CONTEXT_BYTES",
  "LITE_HARNESS_SNAPSHOT_COMPACTION_CONCURRENCY", "LITE_HARNESS_SNAPSHOT_MAX_LOAD_PER_CPU",
  "LITE_HARNESS_SNAPSHOT_MIN_FREE_BYTES", "LITE_HARNESS_CACHE_GC_INTERVAL_MS",
  "LITE_HARNESS_CACHE_QUOTA_BYTES", "LITE_HARNESS_CACHE_MAX_ENTRIES", "LITE_HARNESS_CACHE_MAX_ENTRY_BYTES",
  "LITE_HARNESS_CACHE_MAX_FILES",
  "LITE_HARNESS_DELEGATED_TOOLS", "LITE_HARNESS_CODEX_COMMAND", "LITE_HARNESS_CLAUDE_COMMAND",
  "LITE_HARNESS_ROUTE_GENERATION", "LITE_HARNESS_BROWSER_IMAGE",
  "LITE_HARNESS_BROWSER_ALLOWED_ORIGINS", "LITE_HARNESS_BROWSER_PROFILE_ID",
  "LITE_HARNESS_BROWSER_REMOTE_CDP", "LITE_HARNESS_APP_ID", "LITE_HARNESS_TENANT_ID",
  "LITE_HARNESS_USER_ID", "LITE_HARNESS_DEFAULT_AGENT_ID", "LITE_HARNESS_DEFAULT_WORKSPACE_ID",
  "LITE_HARNESS_HOST", "LITE_HARNESS_PORT",
  "LITE_HARNESS_AUTH_FAILURE_LIMIT", "LITE_HARNESS_AUTH_FAILURE_WINDOW_MS",
  "LITE_HARNESS_APP_CALLBACK_URL", "LITE_HARNESS_WEBHOOK_REPLY_URL",
  "LITE_HARNESS_WEBHOOK_ACCOUNT", "LITE_HARNESS_WEBHOOK_SENDER",
  "LITE_HARNESS_WEBHOOK_APP_ID", "LITE_HARNESS_WEBHOOK_TENANT_ID",
  "LITE_HARNESS_WEBHOOK_USER_ID", "LITE_HARNESS_WEBHOOK_AGENT_ID",
  "LITE_HARNESS_WEBHOOK_WORKSPACE_ID", "LITE_HARNESS_WEBHOOK_SESSION_PREFIX",
  "LITE_HARNESS_SCHEDULES_JSON",
] as const;

const MANAGER_ENVIRONMENT_KEYS = new Set([
  "LITE_HARNESS_MANAGER_SOCKET", "LITE_HARNESS_PROVIDER", "LITE_HARNESS_PROVIDER_BASE_URL",
  "LITE_HARNESS_MODEL", "LITE_HARNESS_MODEL_CATALOG", "LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION",
  "LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION", "LITE_HARNESS_RUNTIME", "LITE_HARNESS_RUNTIME_IMAGE",
  "LITE_HARNESS_MODE", "LITE_HARNESS_OFFLINE", "LITE_HARNESS_APPROVAL_TIMEOUT_MS",
  "LITE_HARNESS_SHUTDOWN_TIMEOUT_MS", "LITE_HARNESS_WORKSPACE_QUOTA_BYTES", "LITE_HARNESS_BROWSER_IDLE_MS",
  "LITE_HARNESS_MODEL_CONTEXT", "LITE_HARNESS_DELEGATED_MAX_BUDGET_USD", "LITE_HARNESS_RUNTIME_MEMORY",
  "LITE_HARNESS_RUNTIME_CPUS", "LITE_HARNESS_RUNTIME_PIDS", "LITE_HARNESS_ENABLE_MEMORY",
  "LITE_HARNESS_REQUIRE_APPROVALS", "LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT",
  "LITE_HARNESS_BROWSER_ALLOW_PRIVATE", "LITE_HARNESS_CONTEXT_OPTIMIZATION", "LITE_HARNESS_ENABLE_PLUGINS",
  "LITE_HARNESS_ENABLE_CACHE_CATALOG", "LITE_HARNESS_CREDENTIAL_PROFILE", "LITE_HARNESS_CREDENTIAL_STORE",
  "LITE_HARNESS_TOOL_PROFILE", "LITE_HARNESS_DELEGATED_TOOLS", "LITE_HARNESS_CODEX_COMMAND",
  "LITE_HARNESS_CLAUDE_COMMAND", "LITE_HARNESS_ROUTE_GENERATION", "LITE_HARNESS_BROWSER_IMAGE",
  "LITE_HARNESS_BROWSER_ALLOWED_ORIGINS", "LITE_HARNESS_BROWSER_PROFILE_ID", "LITE_HARNESS_BROWSER_REMOTE_CDP",
  "LITE_HARNESS_CONTEXT_FILE", "LITE_HARNESS_CONTEXT_KIND", "LITE_HARNESS_CONTEXT_ALLOWED_APPS",
  "LITE_HARNESS_CONTEXT_ALLOWED_MODELS", "LITE_HARNESS_CONTEXT_KILLED_APPS", "LITE_HARNESS_CONTEXT_KILLED_MODELS",
  "LITE_HARNESS_SKILL_ROOTS", "LITE_HARNESS_SKILL_CAPABILITIES", "LITE_HARNESS_MCP_SERVERS",
  "LITE_HARNESS_PLUGIN_IMAGE", "LITE_HARNESS_PLUGIN_IDLE_MS", "LITE_HARNESS_PLUGIN_RPC_TIMEOUT_MS",
  "LITE_HARNESS_PLUGIN_INVOCATION_TIMEOUT_MS", "LITE_HARNESS_PLUGIN_CLEANUP_RETRY_MS",
  "LITE_HARNESS_PLUGIN_CLEANUP_ATTEMPTS", "LITE_HARNESS_PLUGIN_CLEANUP_TIMEOUT_MS",
  "LITE_HARNESS_PLUGIN_CRASH_BACKOFF_BASE_MS", "LITE_HARNESS_PLUGIN_CRASH_BACKOFF_MAX_MS",
  "LITE_HARNESS_MEMORY_CONTEXT_ENTRIES", "LITE_HARNESS_MEMORY_CONTEXT_BYTES",
  "LITE_HARNESS_SNAPSHOT_COMPACTION_CONCURRENCY", "LITE_HARNESS_SNAPSHOT_MAX_LOAD_PER_CPU",
  "LITE_HARNESS_SNAPSHOT_MIN_FREE_BYTES", "LITE_HARNESS_CACHE_GC_INTERVAL_MS",
  "LITE_HARNESS_CACHE_QUOTA_BYTES", "LITE_HARNESS_CACHE_MAX_ENTRIES", "LITE_HARNESS_CACHE_MAX_ENTRY_BYTES",
  "LITE_HARNESS_CACHE_MAX_FILES",
  "LITE_HARNESS_APP_CALLBACK_URL", "LITE_HARNESS_WEBHOOK_REPLY_URL", "LITE_HARNESS_WEBHOOK_ACCOUNT",
  "LITE_HARNESS_WEBHOOK_SENDER", "LITE_HARNESS_WEBHOOK_APP_ID", "LITE_HARNESS_WEBHOOK_TENANT_ID",
  "LITE_HARNESS_WEBHOOK_USER_ID", "LITE_HARNESS_WEBHOOK_AGENT_ID", "LITE_HARNESS_WEBHOOK_WORKSPACE_ID",
  "LITE_HARNESS_WEBHOOK_SESSION_PREFIX", "LITE_HARNESS_SCHEDULES_JSON",
]);

const GATEWAY_ENVIRONMENT_KEYS = new Set([
  "LITE_HARNESS_MANAGER_SOCKET", "LITE_HARNESS_APP_ID", "LITE_HARNESS_TENANT_ID", "LITE_HARNESS_USER_ID",
  "LITE_HARNESS_HOST", "LITE_HARNESS_PORT", "LITE_HARNESS_AUTH_FAILURE_LIMIT", "LITE_HARNESS_AUTH_FAILURE_WINDOW_MS",
]);

const MANAGER_SECRET_KEYS = new Set([
  "LITE_HARNESS_INTERNAL_TOKEN", "LITE_HARNESS_PROVIDER_API_KEY", "LITE_HARNESS_SNAPSHOT_KEY",
  "LITE_HARNESS_CREDENTIAL_RECOVERY_KEY", "LITE_HARNESS_APP_CALLBACK_SECRET", "LITE_HARNESS_WEBHOOK_SECRET", "LITE_HARNESS_WEBHOOK_REPLY_SECRET",
]);
const GATEWAY_SECRET_KEYS = new Set(["LITE_HARNESS_INTERNAL_TOKEN", "LITE_HARNESS_APP_TOKEN"]);
const HOST_ENVIRONMENT_KEYS = ["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC"] as const;

export interface ValidatedInstallationConfiguration {
  schemaVersion: typeof LITE_CONFIG_SCHEMA_VERSION;
  dataDir: string;
  environment: Readonly<Record<string, string>>;
}

export interface InstallationConfigurationOptions {
  /** Allow a first-run install to materialize an explicit development/fake profile. */
  developmentDefaults?: boolean;
}

export interface ValidatedManagerConfiguration {
  schemaVersion: typeof LITE_CONFIG_SCHEMA_VERSION;
  dataDir: string;
  socketPath: string;
  internalToken: string;
  provider: string;
  runtime: "fake" | "docker";
  mode: "development" | "production";
  offline: boolean;
  approvalTimeoutMs: number;
  shutdownTimeoutMs: number;
  workspaceQuotaBytes: number;
  browserIdleMs: number;
  modelContext?: number;
  delegatedMaxBudgetUsd?: number;
  runtimeMemory: string;
  runtimeCpus: string;
  runtimePids: number;
  memoryEnabled: boolean;
  approvalsRequired: boolean;
  workspaceColdAfterCheckpoint: boolean;
  browserPrivateNetworksAllowed: boolean;
  contextOptimizationEnabled: boolean;
  pluginsEnabled: boolean;
  cacheCatalogEnabled: boolean;
}

export interface ValidatedGatewayConfiguration {
  schemaVersion: typeof LITE_CONFIG_SCHEMA_VERSION;
  dataDir: string;
  socketPath: string;
  internalToken: string;
  appToken: string;
  bootstrapIdentity: { appId: string; tenantId: string; userId: string };
  host: "127.0.0.1" | "::1";
  port: number;
  authFailureLimit: number;
  authFailureWindowMs: number;
}

export interface ValidatedLauncherConfiguration {
  schemaVersion: typeof LITE_CONFIG_SCHEMA_VERSION;
  dataDir: string;
}

export interface ValidatedManagerIpcConfiguration {
  schemaVersion: typeof LITE_CONFIG_SCHEMA_VERSION;
  dataDir: string;
  socketPath: string;
}

export function loadManagerIpcConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): ValidatedManagerIpcConfiguration {
  validateVersion(environment);
  const dataDir = resolveDataDir(environment, cwd, platform);
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir,
    socketPath: resolveSocketPath(environment, dataDir, platform),
  });
}

export function loadManagerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): ValidatedManagerConfiguration {
  validateVersion(environment);
  const dataDir = resolveDataDir(environment, cwd, platform);
  const provider = requiredIdentifier(environment, "LITE_HARNESS_PROVIDER");
  const runtime = requiredEnum(environment, "LITE_HARNESS_RUNTIME", ["fake", "docker"] as const);
  const mode = requiredEnum(environment, "LITE_HARNESS_MODE", ["development", "production"] as const, "production");
  const offline = parseBooleanEnvironment(environment.LITE_HARNESS_OFFLINE, "LITE_HARNESS_OFFLINE");
  if (mode === "production" && (provider === "fake" || runtime === "fake")) {
    throw new Error("Production mode forbids fake provider and runtime implementations");
  }
  if (offline) validateOfflineManagerConfiguration(environment, provider);
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir,
    socketPath: resolveSocketPath(environment, dataDir, platform),
    internalToken: requiredSecret(environment, "LITE_HARNESS_INTERNAL_TOKEN"),
    provider,
    runtime,
    mode,
    offline,
    approvalTimeoutMs: boundedInteger(environment.LITE_HARNESS_APPROVAL_TIMEOUT_MS, "LITE_HARNESS_APPROVAL_TIMEOUT_MS", 1_000, 3_600_000, 60_000),
    shutdownTimeoutMs: boundedInteger(environment.LITE_HARNESS_SHUTDOWN_TIMEOUT_MS, "LITE_HARNESS_SHUTDOWN_TIMEOUT_MS", 1_000, 600_000, 30_000),
    workspaceQuotaBytes: boundedInteger(environment.LITE_HARNESS_WORKSPACE_QUOTA_BYTES, "LITE_HARNESS_WORKSPACE_QUOTA_BYTES", 1024 * 1024, 100 * 1024 * 1024 * 1024, 1024 * 1024 * 1024),
    browserIdleMs: boundedInteger(environment.LITE_HARNESS_BROWSER_IDLE_MS, "LITE_HARNESS_BROWSER_IDLE_MS", 1_000, 3_600_000, 60_000),
    ...(environment.LITE_HARNESS_MODEL_CONTEXT !== undefined
      ? { modelContext: boundedInteger(environment.LITE_HARNESS_MODEL_CONTEXT, "LITE_HARNESS_MODEL_CONTEXT", 1_024, 2_000_000, 128_000) }
      : {}),
    ...(environment.LITE_HARNESS_DELEGATED_MAX_BUDGET_USD !== undefined
      ? { delegatedMaxBudgetUsd: boundedNumber(environment.LITE_HARNESS_DELEGATED_MAX_BUDGET_USD, "LITE_HARNESS_DELEGATED_MAX_BUDGET_USD", 0, 1_000_000) }
      : {}),
    runtimeMemory: boundedMemory(environment.LITE_HARNESS_RUNTIME_MEMORY, "LITE_HARNESS_RUNTIME_MEMORY", "512m"),
    runtimeCpus: boundedDecimal(environment.LITE_HARNESS_RUNTIME_CPUS, "LITE_HARNESS_RUNTIME_CPUS", 0.1, 64, "1"),
    runtimePids: boundedInteger(environment.LITE_HARNESS_RUNTIME_PIDS, "LITE_HARNESS_RUNTIME_PIDS", 1, 4_096, 128),
    memoryEnabled: parseBooleanEnvironment(environment.LITE_HARNESS_ENABLE_MEMORY, "LITE_HARNESS_ENABLE_MEMORY"),
    approvalsRequired: parseBooleanEnvironment(environment.LITE_HARNESS_REQUIRE_APPROVALS, "LITE_HARNESS_REQUIRE_APPROVALS"),
    workspaceColdAfterCheckpoint: parseBooleanEnvironment(environment.LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT, "LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT"),
    browserPrivateNetworksAllowed: parseBooleanEnvironment(environment.LITE_HARNESS_BROWSER_ALLOW_PRIVATE, "LITE_HARNESS_BROWSER_ALLOW_PRIVATE"),
    contextOptimizationEnabled: parseBooleanEnvironment(environment.LITE_HARNESS_CONTEXT_OPTIMIZATION, "LITE_HARNESS_CONTEXT_OPTIMIZATION"),
    pluginsEnabled: parseBooleanEnvironment(environment.LITE_HARNESS_ENABLE_PLUGINS, "LITE_HARNESS_ENABLE_PLUGINS"),
    cacheCatalogEnabled: parseBooleanEnvironment(environment.LITE_HARNESS_ENABLE_CACHE_CATALOG, "LITE_HARNESS_ENABLE_CACHE_CATALOG"),
  });
}

export function loadGatewayConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): ValidatedGatewayConfiguration {
  validateVersion(environment);
  const dataDir = resolveDataDir(environment, cwd, platform);
  const rawHost = environment.LITE_HARNESS_HOST?.trim() || "127.0.0.1";
  if (rawHost !== "127.0.0.1" && rawHost !== "::1") {
    throw new Error("Alpha Gateway binding is loopback-only; LITE_HARNESS_HOST must be 127.0.0.1 or ::1");
  }
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir,
    socketPath: resolveSocketPath(environment, dataDir, platform),
    internalToken: requiredSecret(environment, "LITE_HARNESS_INTERNAL_TOKEN"),
    appToken: requiredSecret(environment, "LITE_HARNESS_APP_TOKEN"),
    bootstrapIdentity: {
      appId: optionalSlug(environment, "LITE_HARNESS_APP_ID", "app_local"),
      tenantId: optionalSlug(environment, "LITE_HARNESS_TENANT_ID", "tenant_local"),
      userId: optionalSlug(environment, "LITE_HARNESS_USER_ID", "user_local"),
    },
    host: rawHost,
    port: boundedInteger(environment.LITE_HARNESS_PORT, "LITE_HARNESS_PORT", 1, 65_535, 3_210),
    authFailureLimit: boundedInteger(environment.LITE_HARNESS_AUTH_FAILURE_LIMIT, "LITE_HARNESS_AUTH_FAILURE_LIMIT", 1, 10_000, 20),
    authFailureWindowMs: boundedInteger(environment.LITE_HARNESS_AUTH_FAILURE_WINDOW_MS, "LITE_HARNESS_AUTH_FAILURE_WINDOW_MS", 1_000, 3_600_000, 60_000),
  });
}

export function loadLauncherConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): ValidatedLauncherConfiguration {
  validateVersion(environment);
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir: resolveDataDir(environment, cwd, platform),
  });
}

export function loadInstallationConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  options: InstallationConfigurationOptions = {},
): ValidatedInstallationConfiguration {
  validateVersion(environment);
  const dataDir = resolveDataDir(environment, cwd, platform);
  let durableEnvironment = collectInstallationEnvironment(environment);
  const hasProvider = durableEnvironment.LITE_HARNESS_PROVIDER !== undefined;
  const hasRuntime = durableEnvironment.LITE_HARNESS_RUNTIME !== undefined;
  const hasMode = durableEnvironment.LITE_HARNESS_MODE !== undefined;
  if (options.developmentDefaults && !hasProvider && !hasRuntime && !hasMode) {
    durableEnvironment = {
      ...durableEnvironment,
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_MODE: "development",
    };
  }
  const validationEnvironment = {
    ...durableEnvironment,
    LITE_HARNESS_DATA_DIR: dataDir,
    LITE_HARNESS_INTERNAL_TOKEN: "installation-validation-internal-token",
    LITE_HARNESS_APP_TOKEN: "installation-validation-app-token",
  };
  loadManagerConfiguration(validationEnvironment, cwd, platform);
  loadGatewayConfiguration(validationEnvironment, cwd, platform);
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir,
    environment: Object.freeze(durableEnvironment),
  });
}

export function readInstallationConfiguration(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): ValidatedInstallationConfiguration {
  const pathModule = platformPath(platform);
  const resolvedDataDir = pathModule.resolve(dataDir);
  const path = pathModule.join(resolvedDataDir, LITE_INSTALLATION_CONFIGURATION_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Installed Lite-Harness configuration is missing at ${path}; run \'pnpm lite service install\'`);
    }
    throw new Error("Installed Lite-Harness configuration is unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Installed Lite-Harness configuration must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== LITE_CONFIG_SCHEMA_VERSION || typeof record.dataDir !== "string" ||
      !record.environment || typeof record.environment !== "object" || Array.isArray(record.environment)) {
    throw new Error("Installed Lite-Harness configuration has an unsupported shape");
  }
  const persistedDataDir = pathModule.resolve(record.dataDir);
  if (persistedDataDir !== resolvedDataDir) throw new Error("Installed Lite-Harness configuration data directory does not match its location");
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(record.environment as Record<string, unknown>)) {
    if (!(LITE_INSTALLATION_ENVIRONMENT_KEYS as readonly string[]).includes(name) || typeof value !== "string") {
      throw new Error("Installed Lite-Harness configuration contains an unsupported environment entry");
    }
    validateDurableEnvironmentValue(name, value);
    environment[name] = value;
  }
  return loadInstallationConfiguration({ ...environment, LITE_HARNESS_DATA_DIR: resolvedDataDir }, resolvedDataDir, platform);
}

export function writeInstallationConfiguration(configuration: ValidatedInstallationConfiguration): string {
  const path = join(configuration.dataDir, LITE_INSTALLATION_CONFIGURATION_FILE);
  mkdirSync(configuration.dataDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(configuration, null, 2)}\n`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporaryPath, 0o600); } catch { /* Windows has no POSIX mode bits. */ }
  renameSync(temporaryPath, path);
  return path;
}

export type LiteHarnessRole = "manager" | "gateway";

export function buildRoleEnvironment(
  role: LiteHarnessRole,
  configuration: ValidatedInstallationConfiguration,
  overrides: NodeJS.ProcessEnv = process.env,
  secrets: NodeJS.ProcessEnv = overrides,
): NodeJS.ProcessEnv {
  const roleKeys = role === "manager" ? MANAGER_ENVIRONMENT_KEYS : GATEWAY_ENVIRONMENT_KEYS;
  const secretKeys = role === "manager" ? MANAGER_SECRET_KEYS : GATEWAY_SECRET_KEYS;
  const environment: NodeJS.ProcessEnv = {
    LITE_HARNESS_CONFIG_VERSION: String(LITE_CONFIG_SCHEMA_VERSION),
    LITE_HARNESS_DATA_DIR: configuration.dataDir,
  };
  for (const name of roleKeys) {
    const value = overrides[name] ?? configuration.environment[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of secretKeys) {
    const value = secrets[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of HOST_ENVIRONMENT_KEYS) {
    const value = overrides[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function collectInstallationEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of LITE_INSTALLATION_ENVIRONMENT_KEYS) {
    const value = environment[name];
    if (value !== undefined) {
      validateDurableEnvironmentValue(name, value);
      result[name] = value;
    }
  }
  return result;
}

function validateDurableEnvironmentValue(name: string, value: string): void {
  if (value.length > 1024 * 1024 || /[\0\r\n]/.test(value)) {
    throw new Error(`Installation environment value ${name} is invalid`);
  }
}

function validateVersion(environment: NodeJS.ProcessEnv): void {
  const configured = environment.LITE_HARNESS_CONFIG_VERSION?.trim();
  if (configured !== undefined && configured !== String(LITE_CONFIG_SCHEMA_VERSION)) {
    throw new Error(`Unsupported LITE_HARNESS_CONFIG_VERSION ${configured || "<empty>"}; expected ${LITE_CONFIG_SCHEMA_VERSION}`);
  }
}

function resolveDataDir(environment: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const configured = environment.LITE_HARNESS_DATA_DIR?.trim();
  const pathModule = platformPath(platform);
  const path = pathModule.resolve(configured || pathModule.join(cwd, ".lite-harness"));
  if (!pathModule.isAbsolute(path)) throw new Error("LITE_HARNESS_DATA_DIR must resolve to an absolute path");
  return path;
}

function resolveSocketPath(environment: NodeJS.ProcessEnv, dataDir: string, platform: NodeJS.Platform): string {
  const configured = environment.LITE_HARNESS_MANAGER_SOCKET?.trim();
  const pathModule = platformPath(platform);
  const installationId = createHash("sha256").update(pathModule.resolve(dataDir).toLowerCase(), "utf8").digest("hex").slice(0, 16);
  const path = configured || (platform === "win32"
    ? `\\\\.\\pipe\\lite-harness-manager-${installationId}`
    : pathModule.join(dataDir, "manager.sock"));
  if (platform === "win32") {
    if (!path.startsWith("\\\\.\\pipe\\") || path.length > 240) throw new Error("LITE_HARNESS_MANAGER_SOCKET must be a bounded local Windows named pipe");
    return path;
  }
  if (!pathModule.isAbsolute(path)) throw new Error("LITE_HARNESS_MANAGER_SOCKET must be an absolute Unix socket path");
  if (Buffer.byteLength(path) > 100) throw new Error("LITE_HARNESS_MANAGER_SOCKET exceeds the portable Unix socket path limit");
  return path;
}

function platformPath(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function requiredSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || value.length < 16 || value.length > 4_096 || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must be a single-line value between 16 and 4096 characters`);
  }
  return value;
}

function requiredIdentifier(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error(`${name} is required and must be a lowercase identifier`);
  return value;
}

function optionalSlug(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = environment[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`${name} must be a bounded identifier`);
  return value;
}

function requiredEnum<const T extends readonly string[]>(
  environment: NodeJS.ProcessEnv,
  name: string,
  values: T,
  fallback?: T[number],
): T[number] {
  const value = environment[name]?.trim() || fallback;
  if (!value || !values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

function boundedInteger(value: string | undefined, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseBooleanEnvironment(value: string | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  const configured = value.trim();
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function validateOfflineManagerConfiguration(environment: NodeJS.ProcessEnv, provider: string): void {
  if (provider !== "fake") {
    if (provider !== "openai-compatible" || !isLoopbackHttpUrl(environment.LITE_HARNESS_PROVIDER_BASE_URL?.trim() ?? "")) {
      throw new Error("Offline mode requires the fake provider or an openai-compatible provider at a loopback HTTP(S) URL");
    }
  }
  const outboundSettings = [
    "LITE_HARNESS_APP_CALLBACK_URL",
    "LITE_HARNESS_WEBHOOK_REPLY_URL",
    "LITE_HARNESS_BROWSER_IMAGE",
    "LITE_HARNESS_BROWSER_REMOTE_CDP",
  ].filter((name) => environment[name]?.trim());
  if (outboundSettings.length) {
    throw new Error(`Offline mode forbids outbound-capable settings: ${outboundSettings.join(", ")}`);
  }
}

function boundedNumber(value: string, name: string, minimum: number, maximum: number): number {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) throw new Error(`${name} must be a finite non-negative number`);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function boundedDecimal(value: string | undefined, name: string, minimum: number, maximum: number, fallback: string): string {
  const configured = value?.trim() || fallback;
  if (!/^(?:0\.[1-9]\d{0,2}|[1-9]\d{0,1}(?:\.\d{1,3})?)$/.test(configured)) {
    throw new Error(`${name} must be a finite decimal between ${minimum} and ${maximum}`);
  }
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return configured;
}

function boundedMemory(value: string | undefined, name: string, fallback: string): string {
  const configured = value?.trim().toLowerCase() || fallback;
  const match = /^(\d+)(b|k|kb|m|mb|g|gb)$/.exec(configured);
  if (!match) throw new Error(`${name} must be a bounded Docker memory value`);
  const amount = Number(match[1]);
  const multiplier = match[2].startsWith("g") ? 1024 ** 3 : match[2].startsWith("m") ? 1024 ** 2 : match[2].startsWith("k") ? 1024 : 1;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024 * 1024) {
    throw new Error(`${name} must be between 16 MiB and 64 GiB`);
  }
  return configured;
}
