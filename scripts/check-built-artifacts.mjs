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
  const isolationCredentials = [
    { dimension: "app", token: "artifact-app-token-other-app", appId: "app_secondary", tenantId: "tenant_local", userId: "user_local" },
    { dimension: "tenant", token: "artifact-app-token-other-tenant", appId: "app_local", tenantId: "tenant_secondary", userId: "user_local" },
    { dimension: "user", token: "artifact-app-token-other-user", appId: "app_local", tenantId: "tenant_local", userId: "user_secondary" },
  ];
  for (const credential of isolationCredentials) {
    const seeder = start(resolve(installedApplication, "gateway", "main.js"), {
      ...environment,
      LITE_HARNESS_APP_TOKEN: credential.token,
      LITE_HARNESS_APP_ID: credential.appId,
      LITE_HARNESS_TENANT_ID: credential.tenantId,
      LITE_HARNESS_USER_ID: credential.userId,
    }, fixture);
    await waitForReady(`${baseUrl}/healthz`, [seeder]);
    await stop(seeder);
  }
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
  writeFileSync(smoke, `import { AUTHENTICATED_OPERATION_METHODS, AUTHENTICATED_OPERATION_ROUTES, GENERATED_API_OPERATIONS, LiteHarnessClient, LiteHarnessError } from "@lite-harness/sdk";
const expectedAuthenticatedOperations = GENERATED_API_OPERATIONS
  .filter((operation) => operation.path.startsWith("/v1/"))
  .map((operation) => [operation.method, operation.path, operation.operationId, AUTHENTICATED_OPERATION_METHODS[operation.operationId]]);
if (JSON.stringify(AUTHENTICATED_OPERATION_ROUTES) !== JSON.stringify(expectedAuthenticatedOperations) ||
    expectedAuthenticatedOperations.length !== Object.keys(AUTHENTICATED_OPERATION_METHODS).length) {
  throw new Error("Packaged TypeScript SDK OpenAPI operation coverage drifted");
}
for (const methodName of Object.values(AUTHENTICATED_OPERATION_METHODS)) {
  if (typeof LiteHarnessClient.prototype[methodName] !== "function") throw new Error("Packaged TypeScript SDK operation is missing: " + methodName);
}
const client = new LiteHarnessClient({ baseUrl: process.argv[2], token: "artifact-app-token" });
const isolationClients = ${JSON.stringify(isolationCredentials.map(({ dimension, token }) => ({ dimension, token })))}
  .map(({ dimension, token }) => ({ dimension, client: new LiteHarnessClient({ baseUrl: process.argv[2], token }) }));
await client.createAgent({ id: "artifact-coder", name: "Packaged artifact coder", allowedTools: ["write_file", "artifact_publish"] });
const created = await client.createRun({ agent: "artifact-coder", workspace: "packaged-workspace", input: "create and publish the fixture" }, "packaged-ipc-smoke");
let run;
for (let attempt = 0; attempt < 100; attempt += 1) {
  run = await client.getRun(created.runId);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (run?.status !== "SUCCEEDED") throw new Error("Packaged run did not succeed: " + JSON.stringify(run));
let artifactId;
for await (const event of client.events(created.runId)) {
  if (event.type === "artifact.created" && typeof event.payload.artifactId === "string") artifactId = event.payload.artifactId;
}
if (!artifactId) throw new Error("Packaged run did not expose its artifact.created event");
const downloadedArtifact = await client.downloadArtifact(artifactId);
if (downloadedArtifact.record.id !== artifactId || downloadedArtifact.data.byteLength === 0) {
  throw new Error("Installed TypeScript SDK did not round-trip artifact bytes");
}
for (const isolated of isolationClients) {
  await expectHttpError(() => isolated.client.downloadArtifact(artifactId), 404, "not_found", "Artifact not found");
}
await expectHttpError(() => client.downloadArtifact("art_ffffffffffffffffffffffffffffffff"), 404, "not_found", "Artifact not found");
await expectHttpError(() => client.downloadArtifact("art_invalid"), 404, "not_found", "Artifact not found");
await expectHttpError(() => isolationClients[0].client.getRun(created.runId), 404, "not_found");
const spoofed = await fetch(process.argv[2] + "/v1/runs/" + encodeURIComponent(created.runId), {
  headers: { authorization: "Bearer artifact-app-token", "x-lite-tenant-id": "tenant_secondary", "x-lite-user-id": "user_secondary" },
});
if (!spoofed.ok) throw new Error("Caller-selected identity headers changed the authenticated owner");
await expectHttpError(
  () => client.mintRunToken({ scopes: ["tokens:mint"], agentId: "artifact-coder", workspaceId: "packaged-workspace" }),
  403,
  "token_scope_expansion",
);
const minted = await client.mintRunToken({
  scopes: ["runs:create", "runs:read"],
  agentId: "artifact-coder",
  workspaceId: "packaged-workspace",
  budgetCeiling: { maxTurns: 3 },
});
if (minted.replayPolicy !== "resource_bound_multi_use") throw new Error("Run-token replay policy was not explicit");
const bound = new LiteHarnessClient({ baseUrl: process.argv[2], token: minted.token });
if ((await bound.getRun(created.runId)).id !== created.runId) throw new Error("Bound token could not read its matching resource");
await expectHttpError(() => bound.listAgents(), 403, "insufficient_scope");
await expectHttpError(
  () => bound.createRun({ agent: "artifact-coder", workspace: "other-workspace", input: "must fail", budget: { maxTurns: 3 } }),
  403,
  "token_binding_violation",
);
await expectHttpError(
  () => bound.createRun({ agent: "artifact-coder", workspace: "packaged-workspace", input: "must exceed default ceiling" }),
  403,
  "token_binding_violation",
);
const boundedCreated = await bound.createRun(
  { agent: "artifact-coder", workspace: "packaged-workspace", input: "bounded fixture", budget: { maxTurns: 3 } },
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

async function expectHttpError(action, status, code, message) {
  try {
    await action();
  } catch (error) {
    if (error instanceof LiteHarnessError && error.status === status && error.code === code &&
        (message === undefined || error.message === message) && error.retryable === false &&
        error.retryAfterMs === undefined && error.details === undefined) return;
    throw error;
  }
  throw new Error("Expected uniform HTTP " + status + " with code " + code);
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
from lite_harness import API_OPERATIONS, AUTHENTICATED_OPERATION_METHODS, AUTHENTICATED_OPERATION_ROUTES, LiteHarnessClient, LiteHarnessError

def expect_http_error(action, status, code, message=None):
    try:
        action()
    except LiteHarnessError as error:
        if (error.status == status and error.code == code and
                (message is None or str(error) == message) and not error.retryable and
                error.retry_after_ms is None and error.details is None):
            return
        raise
    raise RuntimeError(f"Expected uniform HTTP {status} with code {code}")

expected = tuple((method, path, operation_id, AUTHENTICATED_OPERATION_METHODS[operation_id]) for method, path, operation_id in API_OPERATIONS if path.startswith("/v1/"))
if AUTHENTICATED_OPERATION_ROUTES != expected or len(expected) != len(AUTHENTICATED_OPERATION_METHODS):
    raise RuntimeError("Packaged Python SDK OpenAPI operation coverage drifted")
for _operation_id, method_name in AUTHENTICATED_OPERATION_METHODS.items():
    if not callable(getattr(LiteHarnessClient, method_name, None)):
        raise RuntimeError("Packaged Python SDK operation is missing: " + method_name)
client = LiteHarnessClient(sys.argv[1], "artifact-app-token")
isolation_clients = [(item["dimension"], LiteHarnessClient(sys.argv[1], item["token"]))
                     for item in json.loads(sys.argv[2])]
created = client.create_run(agent="artifact-coder", workspace="python-packaged-workspace", input="create and publish the Python fixture", idempotency_key="python-packaged-ipc-smoke")
run = None
for _ in range(100):
    run = client.get_run(created["runId"])
    if run["status"] in {"SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"}:
        break
    time.sleep(0.025)
if not run or run["status"] != "SUCCEEDED":
    raise RuntimeError("Packaged Python run did not succeed: " + json.dumps(run))
artifact_id = next((event["payload"]["artifactId"] for event in client.events(run["id"])
                    if event.get("type") == "artifact.created" and isinstance(event.get("payload", {}).get("artifactId"), str)), None)
if not artifact_id:
    raise RuntimeError("Packaged Python run did not expose its artifact.created event")
downloaded = client.download_artifact(artifact_id)
if downloaded["record"]["id"] != artifact_id or not downloaded["data"]:
    raise RuntimeError("Installed Python SDK did not round-trip artifact bytes")
for _, isolated_client in isolation_clients:
    expect_http_error(lambda isolated_client=isolated_client: isolated_client.download_artifact(artifact_id),
                      404, "not_found", "Artifact not found")
expect_http_error(lambda: client.download_artifact("art_ffffffffffffffffffffffffffffffff"),
                  404, "not_found", "Artifact not found")
expect_http_error(lambda: client.download_artifact("art_invalid"), 404, "not_found", "Artifact not found")
print(json.dumps({"runId": run["id"], "status": run["status"], "artifactId": artifact_id}))
`);
    const pythonResult = JSON.parse(execFileSync(python, ["-I", pythonSmoke, baseUrl, JSON.stringify(isolationCredentials)], { cwd: fixture, encoding: "utf8" }));
    if (pythonResult.status !== "SUCCEEDED") throw new Error(`Unexpected Python packaged smoke result: ${JSON.stringify(pythonResult)}`);
  }
  assertNoPlaintextSecrets(dataDir, [environment.LITE_HARNESS_APP_TOKEN, ...isolationCredentials.map(({ token }) => token)]);
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
    artifactCreatedEventExposesIdThroughBothSdks: true,
    artifactMetadataAndBytesRoundTripThroughBothSdks: true,
    artifactCrossAppReturnsUniformNotFound: true,
    artifactCrossTenantReturnsUniformNotFound: true,
    artifactCrossUserReturnsUniformNotFound: true,
    guessedArtifactIdsReturnUniformNotFound: true,
    malformedArtifactIdsReturnUniformNotFound: true,
    runTokenScopesAndBindings: true,
    runTokenRevocation: true,
    plaintextTokenPersistenceDenied: true,
  };
  const allAssertions = Object.keys(assertions);
  const authAssertions = [
    "serverResolvedIdentity", "crossOwnerIsolation", "runTokenScopesAndBindings",
    "runTokenRevocation", "plaintextTokenPersistenceDenied", "artifactCreatedEventExposesIdThroughBothSdks",
    "artifactMetadataAndBytesRoundTripThroughBothSdks",
    "artifactCrossAppReturnsUniformNotFound", "artifactCrossTenantReturnsUniformNotFound",
    "artifactCrossUserReturnsUniformNotFound", "guessedArtifactIdsReturnUniformNotFound",
    "malformedArtifactIdsReturnUniformNotFound",
  ];
  writePolicyEvidence({
    root,
    output,
    suite,
    command: "pnpm check:artifacts --python-wheel",
    assertions,
    requirementIds: authSuite ? ["D09", "D10", "A12", "R24-2071"] : ["A02", "A12", "R24-2071"],
    regressionIds: authSuite
      ? ["BD-001-REGRESSION", "BD-035-REGRESSION"]
      : [
          "BD-001-REGRESSION", "BD-051-REGRESSION", "BD-052-REGRESSION",
          "BD-053-REGRESSION", "BD-054-REGRESSION", "BD-060-REGRESSION", "BD-035-REGRESSION",
        ],
    claims: {
      runtime: "deterministic-fake",
      provider: "deterministic-fake",
      legacyNonLedgerLabel: authSuite ? null : "M1-EXIT",
    },
    sourcePath: "scripts/check-built-artifacts.mjs",
    caseBindings: authSuite
      ? { A12: [
          "artifactCreatedEventExposesIdThroughBothSdks", "artifactMetadataAndBytesRoundTripThroughBothSdks", "artifactCrossAppReturnsUniformNotFound",
          "artifactCrossTenantReturnsUniformNotFound", "artifactCrossUserReturnsUniformNotFound",
          "guessedArtifactIdsReturnUniformNotFound", "malformedArtifactIdsReturnUniformNotFound",
        ], "R24-2071": [
          "artifactCreatedEventExposesIdThroughBothSdks",
        ], "BD-001-REGRESSION": authAssertions, "BD-035-REGRESSION": [
          "artifactCreatedEventExposesIdThroughBothSdks", "artifactMetadataAndBytesRoundTripThroughBothSdks", "artifactCrossAppReturnsUniformNotFound",
          "artifactCrossTenantReturnsUniformNotFound", "artifactCrossUserReturnsUniformNotFound",
          "guessedArtifactIdsReturnUniformNotFound", "malformedArtifactIdsReturnUniformNotFound",
        ] }
      : {
          A02: allAssertions,
          A12: [
            "artifactCreatedEventExposesIdThroughBothSdks", "artifactMetadataAndBytesRoundTripThroughBothSdks", "artifactCrossAppReturnsUniformNotFound",
            "artifactCrossTenantReturnsUniformNotFound", "artifactCrossUserReturnsUniformNotFound",
            "guessedArtifactIdsReturnUniformNotFound", "malformedArtifactIdsReturnUniformNotFound",
          ],
          "R24-2071": ["artifactCreatedEventExposesIdThroughBothSdks"],
          "M1-EXIT": allAssertions,
          "BD-001-REGRESSION": authAssertions,
          "BD-051-REGRESSION": ["cleanInstalledApplication"],
          "BD-052-REGRESSION": ["cleanInstalledTypeScriptSdk"],
          "BD-053-REGRESSION": ["cleanInstalledPythonWheel"],
          "BD-054-REGRESSION": ["separateManagerAndGatewayProcesses", "realLocalIpc"],
          "BD-060-REGRESSION": ["cleanInstalledApplication", "cleanInstalledTypeScriptSdk", "cleanInstalledPythonWheel"],
          "BD-035-REGRESSION": [
            "artifactCreatedEventExposesIdThroughBothSdks", "artifactMetadataAndBytesRoundTripThroughBothSdks", "artifactCrossAppReturnsUniformNotFound",
            "artifactCrossTenantReturnsUniformNotFound", "artifactCrossUserReturnsUniformNotFound",
            "guessedArtifactIdsReturnUniformNotFound", "malformedArtifactIdsReturnUniformNotFound",
          ],
        },
    packages,
  });
}
