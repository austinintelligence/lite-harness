import { spawn, type ChildProcess } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { createCredentialStore } from "@lite-harness/credential-store";
import { RedactedStreamBuffer, RotatingLogSink } from "@lite-harness/operations";
import {
  buildRoleEnvironment,
  loadInstallationConfiguration,
  loadLauncherConfiguration,
  readInstallationConfiguration,
  type ValidatedInstallationConfiguration,
} from "@lite-harness/config";

const bundled = extname(import.meta.filename) !== ".ts";
const root = resolve(import.meta.dirname, bundled ? "../.." : "../../..");
const dataDirArgument = process.argv.indexOf("--data-dir");
const requestedDataDir = dataDirArgument >= 0 && process.argv[dataDirArgument + 1]
  ? resolve(process.argv[dataDirArgument + 1] as string)
  : process.env.LITE_HARNESS_DATA_DIR;
const launchEnvironment = requestedDataDir === undefined
  ? process.env
  : withEnvironmentOverride(process.env, "LITE_HARNESS_DATA_DIR", requestedDataDir);
const { dataDir } = loadLauncherConfiguration(launchEnvironment);
let installation: ValidatedInstallationConfiguration;
try {
  installation = readInstallationConfiguration(dataDir);
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("configuration is missing")) throw error;
  installation = loadInstallationConfiguration(launchEnvironment);
}
const secrets = createCredentialStore(dataDir, launchEnvironment);
const internalToken = launchEnvironment.LITE_HARNESS_INTERNAL_TOKEN ?? await secrets.get("service.internal-token");
const appToken = launchEnvironment.LITE_HARNESS_APP_TOKEN ?? await secrets.get("service.app-token");
if (!internalToken || !appToken) throw new Error("Service tokens are missing; run `pnpm lite service install`");

const managerSecrets: NodeJS.ProcessEnv = {
  LITE_HARNESS_INTERNAL_TOKEN: internalToken,
  ...explicitEnvironmentSecrets(launchEnvironment),
};

const logs = new RotatingLogSink(join(dataDir, "logs", "lite-harness.jsonl"));
const children = [
  start("manager", applicationEntry("manager"), buildRoleEnvironment("manager", installation, launchEnvironment, managerSecrets)),
  start("gateway", applicationEntry("gateway"), buildRoleEnvironment("gateway", installation, launchEnvironment, {
    LITE_HARNESS_INTERNAL_TOKEN: internalToken,
    LITE_HARNESS_APP_TOKEN: appToken,
  })),
];
let stopping = false;

for (const child of children) {
  child.process.once("exit", (code, signal) => {
    if (!stopping) {
      process.stderr.write(`lite-harness launcher: ${child.name} exited (${code ?? signal ?? "unknown"}); stopping peer\n`);
      process.exitCode = code === 0 ? 1 : code ?? 1;
      stopAll();
    }
  });
}
process.once("SIGINT", stopAll);
process.once("SIGTERM", stopAll);

function start(name: string, entry: string, environment: NodeJS.ProcessEnv): { name: string; process: ChildProcess } {
  const stderrRelay = new RedactedStreamBuffer((text) => process.stderr.write(text));
  const child = spawn(process.execPath, extname(entry) === ".ts" ? ["--import", "tsx", entry] : [entry], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.write(name, "stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    logs.write(name, "stderr", chunk);
    stderrRelay.write(chunk);
  });
  child.once("close", () => {
    logs.flush(name, "stdout");
    logs.flush(name, "stderr");
    stderrRelay.end();
  });
  child.once("error", (error) => {
    stderrRelay.write(`lite-harness launcher: failed to start ${name}: ${error.message}\n`);
    process.exitCode = 1; stopAll();
  });
  return { name, process: child };
}

function withEnvironmentOverride(environment: NodeJS.ProcessEnv, name: string, value: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, current] of Object.entries(environment)) if (current !== undefined) result[key] = current;
  result[name] = value;
  return result;
}

function applicationEntry(name: "manager" | "gateway"): string {
  return bundled
    ? join(root, "apps", name, "main.js")
    : join(root, "apps", name, "src", "main.ts");
}

function explicitEnvironmentSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "LITE_HARNESS_PROVIDER_API_KEY", "LITE_HARNESS_SNAPSHOT_KEY", "LITE_HARNESS_APP_CALLBACK_SECRET",
    "LITE_HARNESS_WEBHOOK_SECRET", "LITE_HARNESS_WEBHOOK_REPLY_SECRET",
  ]) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function stopAll(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children ?? []) if (child.process.exitCode === null) child.process.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children ?? []) if (child.process.exitCode === null) child.process.kill("SIGKILL");
  }, 10_000);
  timer.unref();
}
