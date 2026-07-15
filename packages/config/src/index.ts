import { isAbsolute, join, resolve } from "node:path";

export const LITE_CONFIG_SCHEMA_VERSION = 1 as const;

export interface ValidatedManagerConfiguration {
  schemaVersion: typeof LITE_CONFIG_SCHEMA_VERSION;
  dataDir: string;
  socketPath: string;
  internalToken: string;
  provider: string;
  runtime: "fake" | "docker";
  mode: "development" | "production";
  approvalTimeoutMs: number;
  shutdownTimeoutMs: number;
  workspaceQuotaBytes: number;
  browserIdleMs: number;
  modelContext?: number;
  delegatedMaxBudgetUsd?: number;
  runtimeMemory: string;
  runtimeCpus: string;
  runtimePids: number;
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

export function loadManagerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): ValidatedManagerConfiguration {
  validateVersion(environment);
  const dataDir = resolveDataDir(environment, cwd);
  const provider = requiredIdentifier(environment, "LITE_HARNESS_PROVIDER");
  const runtime = requiredEnum(environment, "LITE_HARNESS_RUNTIME", ["fake", "docker"] as const);
  const mode = requiredEnum(environment, "LITE_HARNESS_MODE", ["development", "production"] as const, "production");
  if (mode === "production" && (provider === "fake" || runtime === "fake")) {
    throw new Error("Production mode forbids fake provider and runtime implementations");
  }
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir,
    socketPath: resolveSocketPath(environment, dataDir, platform),
    internalToken: requiredSecret(environment, "LITE_HARNESS_INTERNAL_TOKEN"),
    provider,
    runtime,
    mode,
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
  });
}

export function loadGatewayConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): ValidatedGatewayConfiguration {
  validateVersion(environment);
  const dataDir = resolveDataDir(environment, cwd);
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
): ValidatedLauncherConfiguration {
  validateVersion(environment);
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir: resolveDataDir(environment, cwd),
  });
}

function validateVersion(environment: NodeJS.ProcessEnv): void {
  const configured = environment.LITE_HARNESS_CONFIG_VERSION?.trim();
  if (configured !== undefined && configured !== String(LITE_CONFIG_SCHEMA_VERSION)) {
    throw new Error(`Unsupported LITE_HARNESS_CONFIG_VERSION ${configured || "<empty>"}; expected ${LITE_CONFIG_SCHEMA_VERSION}`);
  }
}

function resolveDataDir(environment: NodeJS.ProcessEnv, cwd: string): string {
  const configured = environment.LITE_HARNESS_DATA_DIR?.trim();
  const path = resolve(configured || join(cwd, ".lite-harness"));
  if (!isAbsolute(path)) throw new Error("LITE_HARNESS_DATA_DIR must resolve to an absolute path");
  return path;
}

function resolveSocketPath(environment: NodeJS.ProcessEnv, dataDir: string, platform: NodeJS.Platform): string {
  const configured = environment.LITE_HARNESS_MANAGER_SOCKET?.trim();
  const path = configured || (platform === "win32" ? "\\\\.\\pipe\\lite-harness-manager" : join(dataDir, "manager.sock"));
  if (platform === "win32") {
    if (!path.startsWith("\\\\.\\pipe\\") || path.length > 240) throw new Error("LITE_HARNESS_MANAGER_SOCKET must be a bounded local Windows named pipe");
    return path;
  }
  if (!isAbsolute(path)) throw new Error("LITE_HARNESS_MANAGER_SOCKET must be an absolute Unix socket path");
  if (Buffer.byteLength(path) > 100) throw new Error("LITE_HARNESS_MANAGER_SOCKET exceeds the portable Unix socket path limit");
  return path;
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
