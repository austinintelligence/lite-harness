import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { OsSecretStore } from "@lite-harness/credential-store";
import { RotatingLogSink } from "@lite-harness/operations";

const root = resolve(import.meta.dirname, "../../..");
const dataDirArgument = process.argv.indexOf("--data-dir");
const dataDir = dataDirArgument >= 0 && process.argv[dataDirArgument + 1]
  ? resolve(process.argv[dataDirArgument + 1] as string)
  : process.env.LITE_HARNESS_DATA_DIR ?? join(process.cwd(), ".lite-harness");
const secrets = new OsSecretStore({ windowsPath: join(dataDir, "credentials.dpapi.json") });
const internalToken = process.env.LITE_HARNESS_INTERNAL_TOKEN ?? await secrets.get("service.internal-token");
const appToken = process.env.LITE_HARNESS_APP_TOKEN ?? await secrets.get("service.app-token");
if (!internalToken || !appToken) throw new Error("Service tokens are missing; run `pnpm lite service install`");

const environment = {
  ...process.env,
  LITE_HARNESS_DATA_DIR: dataDir,
  LITE_HARNESS_INTERNAL_TOKEN: internalToken,
  LITE_HARNESS_APP_TOKEN: appToken,
};
const logs = new RotatingLogSink(join(dataDir, "logs", "lite-harness.jsonl"));
const children = [
  start("manager", join(root, "apps", "manager", "src", "main.ts")),
  start("gateway", join(root, "apps", "gateway", "src", "main.ts")),
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

function start(name: string, entry: string): { name: string; process: ChildProcess } {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.write(name, "stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    logs.write(name, "stderr", chunk);
    process.stderr.write(chunk);
  });
  child.once("error", (error) => {
    process.stderr.write(`lite-harness launcher: failed to start ${name}: ${error.message}\n`);
    process.exitCode = 1; stopAll();
  });
  return { name, process: child };
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
