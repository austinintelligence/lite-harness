import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(resolve(root, "package.json"), "utf8"))).version;
const required = [
  "dist/apps/manager/main.js",
  "dist/apps/gateway/main.js",
  "dist/apps/launcher/main.js",
  "dist/apps/cli/main.js",
  `dist/packages/lite-harness-contracts-${version}.tgz`,
  `dist/packages/lite-harness-sdk-${version}.tgz`,
];
for (const path of required) if (!existsSync(resolve(root, path))) throw new Error(`Built artifact is missing: ${path}`);

execFileSync(process.execPath, [resolve(root, "dist/apps/cli/main.js"), "help"], { cwd: root, stdio: "pipe" });

const fixture = mkdtempSync(join(tmpdir(), "lite-artifact-check-"));
const children = [];
let logs = "";
try {
  const npm = npmCommand();
  execFileSync(npm.command, [...npm.prefix, "init", "-y"], { cwd: fixture, stdio: "pipe" });
  execFileSync(npm.command, [...npm.prefix, "install", "--ignore-scripts", "--no-audit", "--no-fund",
    resolve(root, required[4]), resolve(root, required[5])], { cwd: fixture, stdio: "pipe" });

  const port = await availablePort();
  const dataDir = resolve(fixture, "data");
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\lite-harness-artifact-${process.pid}-${Date.now()}`
    : resolve(fixture, "manager.sock");
  const environment = {
    ...process.env,
    LITE_HARNESS_DATA_DIR: dataDir,
    LITE_HARNESS_MANAGER_SOCKET: socketPath,
    LITE_HARNESS_INTERNAL_TOKEN: "artifact-internal-token",
    LITE_HARNESS_APP_TOKEN: "artifact-app-token",
    LITE_HARNESS_PROVIDER: "fake",
    LITE_HARNESS_RUNTIME: "fake",
    LITE_HARNESS_HOST: "127.0.0.1",
    LITE_HARNESS_PORT: String(port),
  };
  children.push(start(resolve(root, "dist/apps/manager/main.js"), environment));
  await delay(250);
  children.push(start(resolve(root, "dist/apps/gateway/main.js"), environment));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/readyz`);

  const smoke = resolve(fixture, "smoke.mjs");
  writeFileSync(smoke, `import { LiteHarnessClient } from "@lite-harness/sdk";
const client = new LiteHarnessClient({ baseUrl: process.argv[2], token: "artifact-app-token", tenantId: "tenant", userId: "user" });
const created = await client.createRun({ agent: "coder", workspace: "packaged-workspace", input: "create the fixture" }, "packaged-ipc-smoke");
let run;
for (let attempt = 0; attempt < 100; attempt += 1) {
  run = await client.getRun(created.runId);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (run?.status !== "SUCCEEDED") throw new Error("Packaged run did not succeed: " + JSON.stringify(run));
process.stdout.write(JSON.stringify({ runId: run.id, status: run.status }));
`);
  const result = execFileSync(process.execPath, [smoke, baseUrl], { cwd: fixture, encoding: "utf8" });
  const parsed = JSON.parse(result);
  if (parsed.status !== "SUCCEEDED") throw new Error(`Unexpected packaged smoke result: ${result}`);
  if (process.argv.includes("--python-wheel")) {
    const wheel = readdirOne(resolve(root, "dist", "python"), (name) => name.endsWith(".whl"));
    const environmentRoot = resolve(fixture, "python-env");
    const pythonCommand = process.env.PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3");
    execFileSync(pythonCommand, ["-m", "venv", environmentRoot], { cwd: fixture, stdio: "pipe" });
    const python = resolve(environmentRoot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    execFileSync(python, ["-m", "pip", "install", "--no-deps", "--no-index", wheel], { cwd: fixture, stdio: "pipe" });
    const pythonSmoke = resolve(fixture, "smoke.py");
    writeFileSync(pythonSmoke, `import json, sys, time
from lite_harness import LiteHarnessClient
client = LiteHarnessClient(sys.argv[1], "artifact-app-token", tenant_id="tenant", user_id="user")
created = client.create_run(agent="coder", workspace="python-packaged-workspace", input="create the Python fixture", idempotency_key="python-packaged-ipc-smoke")
run = None
for _ in range(100):
    run = client.get_run(created["runId"])
    if run["status"] in {"SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"}:
        break
    time.sleep(0.025)
if not run or run["status"] != "SUCCEEDED":
    raise RuntimeError("Packaged Python run did not succeed: " + json.dumps(run))
print(json.dumps({"runId": run["id"], "status": run["status"]}))
`);
    const pythonResult = JSON.parse(execFileSync(python, ["-I", pythonSmoke, baseUrl], { cwd: fixture, encoding: "utf8" }));
    if (pythonResult.status !== "SUCCEEDED") throw new Error(`Unexpected Python packaged smoke result: ${JSON.stringify(pythonResult)}`);
  }
  process.stdout.write(`Built artifact checks passed through real packaged IPC (${parsed.runId}).\n`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nProcess logs:\n${logs.slice(-16_000)}`);
} finally {
  await Promise.all(children.map(stop));
  rmSync(fixture, { recursive: true, force: true });
}

function start(entry, env) {
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitForReady(url) {
  let last;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok && (await response.json()).ok === true) return;
      last = new Error(`readiness returned ${response.status}`);
    } catch (error) { last = error; }
    if (children.some((child) => child.exitCode !== null)) throw new Error("Packaged process exited before readiness");
    await delay(50);
  }
  throw last ?? new Error("Packaged harness did not become ready");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function readdirOne(directory, predicate) {
  const matches = readdirSync(directory).filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected one matching artifact in ${directory}, found ${matches.join(", ")}`);
  return resolve(directory, matches[0]);
}

function npmCommand() {
  return process.platform === "win32"
    ? { command: process.execPath, prefix: [resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] }
    : { command: "npm", prefix: [] };
}
