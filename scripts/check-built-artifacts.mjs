import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writePolicyEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceArgument = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceArgument >= 0 ? process.argv[evidenceArgument + 1] : undefined;
const authEvidenceArgument = process.argv.indexOf("--auth-evidence");
const authEvidenceOutput = authEvidenceArgument >= 0 ? process.argv[authEvidenceArgument + 1] : undefined;
if (evidenceArgument >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) {
  throw new Error("--evidence requires an output path");
}
if (authEvidenceArgument >= 0 && (!authEvidenceOutput || authEvidenceOutput.startsWith("--"))) {
  throw new Error("--auth-evidence requires an output path");
}
if ((evidenceOutput || authEvidenceOutput) && !process.argv.includes("--python-wheel")) {
  throw new Error("Packaged evidence requires --python-wheel parity");
}
const version = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(resolve(root, "package.json"), "utf8"))).version;
const required = {
  manager: "dist/apps/manager/main.js",
  gateway: "dist/apps/gateway/main.js",
  launcher: "dist/apps/launcher/main.js",
  cli: "dist/apps/cli/main.js",
  application: `dist/packages/lite-harness-application-${version}.tgz`,
  contracts: `dist/packages/lite-harness-contracts-${version}.tgz`,
  sdk: `dist/packages/lite-harness-sdk-${version}.tgz`,
};
for (const path of Object.values(required)) if (!existsSync(resolve(root, path))) throw new Error(`Built artifact is missing: ${path}`);

const fixture = mkdtempSync(join(tmpdir(), "lite-artifact-check-"));
const children = [];
let logs = "";
try {
  const npm = npmCommand();
  execFileSync(npm.command, [...npm.prefix, "init", "-y"], { cwd: fixture, stdio: "pipe" });
  execFileSync(npm.command, [...npm.prefix, "install", "--ignore-scripts", "--no-audit", "--no-fund",
    resolve(root, required.application), resolve(root, required.contracts), resolve(root, required.sdk)], { cwd: fixture, stdio: "pipe" });
  const installedApplication = resolve(fixture, "node_modules", "@lite-harness", "application", "apps");
  execFileSync(process.execPath, [resolve(installedApplication, "cli", "main.js"), "help"], { cwd: fixture, stdio: "pipe" });

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
    LITE_HARNESS_MODE: "development",
    LITE_HARNESS_HOST: "127.0.0.1",
    LITE_HARNESS_PORT: String(port),
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  const secondaryToken = "artifact-app-token-secondary";
  const seeder = start(resolve(installedApplication, "gateway", "main.js"), {
    ...environment,
    LITE_HARNESS_APP_TOKEN: secondaryToken,
    LITE_HARNESS_APP_ID: "app_secondary",
    LITE_HARNESS_TENANT_ID: "tenant_secondary",
    LITE_HARNESS_USER_ID: "user_secondary",
  }, fixture);
  await waitForReady(`${baseUrl}/healthz`, [seeder]);
  await stop(seeder);
  children.push(start(resolve(installedApplication, "manager", "main.js"), environment, fixture));
  await delay(250);
  children.push(start(resolve(installedApplication, "gateway", "main.js"), environment, fixture));
  await waitForReady(`${baseUrl}/readyz`);

  const contender = start(resolve(installedApplication, "manager", "main.js"), environment, fixture);
  children.push(contender);
  await waitForExit(contender, 5_000);
  if (contender.exitCode === 0) throw new Error("A second packaged Manager unexpectedly acquired the live instance");
  if (children[0].exitCode !== null) throw new Error("The original packaged Manager was displaced by a contender");
  await waitForReady(`${baseUrl}/readyz`);

  const smoke = resolve(fixture, "smoke.mjs");
  writeFileSync(smoke, `import { LiteHarnessClient, LiteHarnessError } from "@lite-harness/sdk";
const client = new LiteHarnessClient({ baseUrl: process.argv[2], token: "artifact-app-token" });
const otherClient = new LiteHarnessClient({ baseUrl: process.argv[2], token: "${secondaryToken}" });
const created = await client.createRun({ agent: "coder", workspace: "packaged-workspace", input: "create the fixture" }, "packaged-ipc-smoke");
let run;
for (let attempt = 0; attempt < 100; attempt += 1) {
  run = await client.getRun(created.runId);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (run?.status !== "SUCCEEDED") throw new Error("Packaged run did not succeed: " + JSON.stringify(run));
await expectHttpError(() => otherClient.getRun(created.runId), 404, "not_found");
const spoofed = await fetch(process.argv[2] + "/v1/runs/" + encodeURIComponent(created.runId), {
  headers: { authorization: "Bearer artifact-app-token", "x-lite-tenant-id": "tenant_secondary", "x-lite-user-id": "user_secondary" },
});
if (!spoofed.ok) throw new Error("Caller-selected identity headers changed the authenticated owner");
await expectHttpError(
  () => client.mintRunToken({ scopes: ["tokens:mint"], agentId: "coder", workspaceId: "packaged-workspace" }),
  403,
  "token_scope_expansion",
);
const minted = await client.mintRunToken({
  scopes: ["runs:create", "runs:read"],
  agentId: "coder",
  workspaceId: "packaged-workspace",
  budgetCeiling: { maxTurns: 2 },
});
if (minted.replayPolicy !== "resource_bound_multi_use") throw new Error("Run-token replay policy was not explicit");
const bound = new LiteHarnessClient({ baseUrl: process.argv[2], token: minted.token });
if ((await bound.getRun(created.runId)).id !== created.runId) throw new Error("Bound token could not read its matching resource");
await expectHttpError(() => bound.listAgents(), 403, "insufficient_scope");
await expectHttpError(
  () => bound.createRun({ agent: "coder", workspace: "other-workspace", input: "must fail", budget: { maxTurns: 2 } }),
  403,
  "token_binding_violation",
);
await expectHttpError(
  () => bound.createRun({ agent: "coder", workspace: "packaged-workspace", input: "must exceed default ceiling" }),
  403,
  "token_binding_violation",
);
const boundedCreated = await bound.createRun(
  { agent: "coder", workspace: "packaged-workspace", input: "bounded fixture", budget: { maxTurns: 2 } },
  "packaged-bound-token-smoke",
);
let boundedRun;
for (let attempt = 0; attempt < 100; attempt += 1) {
  boundedRun = await bound.getRun(boundedCreated.runId);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(boundedRun.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (boundedRun?.status !== "SUCCEEDED") throw new Error("Bound packaged run did not succeed: " + JSON.stringify(boundedRun));
const revoked = await client.revokeToken(minted.tokenId);
if (!revoked.revoked || revoked.tokenId !== minted.tokenId) throw new Error("Run token revocation response was invalid");
await expectHttpError(() => bound.getRun(created.runId), 401, "unauthorized");
process.stdout.write(JSON.stringify({ runId: run.id, status: run.status, boundedRunId: boundedRun.id }));

async function expectHttpError(action, status, code) {
  try {
    await action();
  } catch (error) {
    if (error instanceof LiteHarnessError && error.status === status && error.code === code) return;
    throw error;
  }
  throw new Error("Expected HTTP " + status + " with code " + code);
}
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
client = LiteHarnessClient(sys.argv[1], "artifact-app-token")
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
  assertNoPlaintextSecrets(dataDir, [environment.LITE_HARNESS_APP_TOKEN, secondaryToken]);
  if (evidenceOutput) writeEvidence(evidenceOutput, "m1-packaged-artifacts");
  if (authEvidenceOutput) writeEvidence(authEvidenceOutput, "m2-packaged-auth");
  process.stdout.write(`Built artifact checks passed through real packaged IPC (${parsed.runId}).\n`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nProcess logs:\n${logs.slice(-16_000)}`);
} finally {
  await Promise.all(children.map(stop));
  rmSync(fixture, { recursive: true, force: true });
}

function start(entry, env, cwd = root) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

async function waitForReady(url, monitoredChildren = children) {
  let last;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok && (await response.json()).ok === true) return;
      last = new Error(`readiness returned ${response.status}`);
    } catch (error) { last = error; }
    if (monitoredChildren.some((child) => child.exitCode !== null)) throw new Error("Packaged process exited before readiness");
    await delay(50);
  }
  throw last ?? new Error("Packaged harness did not become ready");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    delay(timeoutMs).then(() => false),
  ]);
  if (!exited) throw new Error("Second packaged Manager did not reject the live instance promptly");
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

function assertNoPlaintextSecrets(directory, secrets) {
  for (const path of walkFiles(directory)) {
    const content = readFileSync(path);
    for (const secret of secrets) {
      if (content.includes(Buffer.from(secret))) throw new Error(`Plaintext app credential was persisted in ${path}`);
    }
  }
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const paths = [];
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) paths.push(...walkFiles(path));
    else paths.push(path);
  }
  return paths;
}

function writeEvidence(output, suite) {
  const packages = [required.application, required.contracts, required.sdk, readdirOne(resolve(root, "dist", "python"), (name) => name.endsWith(".whl"))]
    .map((path) => {
      const absolute = resolve(root, path);
      return {
        name: absolute.startsWith(root) ? absolute.slice(root.length + 1).replaceAll("\\", "/") : absolute,
        sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      };
    });
  const authSuite = suite === "m2-packaged-auth";
  const assertions = {
    cleanInstalledApplication: true,
    cleanInstalledTypeScriptSdk: true,
    cleanInstalledPythonWheel: true,
    separateManagerAndGatewayProcesses: true,
    realLocalIpc: true,
    secondManagerRejected: true,
    serverResolvedIdentity: true,
    crossOwnerIsolation: true,
    runTokenScopesAndBindings: true,
    runTokenRevocation: true,
    plaintextTokenPersistenceDenied: true,
  };
  const allAssertions = Object.keys(assertions);
  const authAssertions = [
    "serverResolvedIdentity", "crossOwnerIsolation", "runTokenScopesAndBindings",
    "runTokenRevocation", "plaintextTokenPersistenceDenied",
  ];
  writePolicyEvidence({
    root,
    output,
    suite,
    command: "pnpm check:artifacts --python-wheel",
    assertions,
    requirementIds: authSuite ? ["D09", "D10"] : ["A02"],
    regressionIds: authSuite
      ? ["BD-001-REGRESSION"]
      : [
          "BD-001-REGRESSION", "BD-006-REGRESSION", "BD-051-REGRESSION", "BD-052-REGRESSION",
          "BD-053-REGRESSION", "BD-054-REGRESSION", "BD-060-REGRESSION",
        ],
    claims: {
      runtime: "deterministic-fake",
      provider: "deterministic-fake",
      legacyNonLedgerLabel: authSuite ? null : "M1-EXIT",
    },
    sourcePath: "scripts/check-built-artifacts.mjs",
    caseBindings: authSuite
      ? { "BD-001-REGRESSION": authAssertions }
      : {
          A02: allAssertions,
          "M1-EXIT": allAssertions,
          "BD-001-REGRESSION": authAssertions,
          "BD-006-REGRESSION": ["separateManagerAndGatewayProcesses", "realLocalIpc", "secondManagerRejected"],
          "BD-051-REGRESSION": ["cleanInstalledApplication"],
          "BD-052-REGRESSION": ["cleanInstalledTypeScriptSdk"],
          "BD-053-REGRESSION": ["cleanInstalledPythonWheel"],
          "BD-054-REGRESSION": ["separateManagerAndGatewayProcesses", "realLocalIpc"],
          "BD-060-REGRESSION": ["cleanInstalledApplication", "cleanInstalledTypeScriptSdk", "cleanInstalledPythonWheel"],
        },
    packages,
  });
}
