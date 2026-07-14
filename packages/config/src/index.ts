import { isAbsolute, join, resolve } from "node:path";

export const LITE_CONFIG_SCHEMA_VERSION = 1 as const;

export interface ValidatedManagerConfiguration {
  schemaVersion: typeof LITE_CONFIG_SCHEMA_VERSION;
  dataDir: string;
  socketPath: string;
  internalToken: string;
  provider: string;
  runtime: "fake" | "docker";
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
  return Object.freeze({
    schemaVersion: LITE_CONFIG_SCHEMA_VERSION,
    dataDir,
    socketPath: resolveSocketPath(environment, dataDir, platform),
    internalToken: requiredSecret(environment, "LITE_HARNESS_INTERNAL_TOKEN"),
    provider: requiredIdentifier(environment, "LITE_HARNESS_PROVIDER"),
    runtime: requiredEnum(environment, "LITE_HARNESS_RUNTIME", ["fake", "docker"] as const),
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

function requiredEnum<const T extends readonly string[]>(environment: NodeJS.ProcessEnv, name: string, values: T): T[number] {
  const value = environment[name]?.trim();
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
