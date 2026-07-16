import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writePolicyEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "lite-doctor-regression-"));
const cases = [];
try {
  const badDockerCommand = createBadDockerFixture(temporary);
  const noContextDockerCommand = createNoContextDockerFixture(temporary);
  cases.push(await runCase("healthy-development", {}, true));
  writeFileSync(join(temporary, "lite-harness.db"), "not a database");
  cases.push(await runCase("corrupt-database", {}, false, ["database"]));
  rmSync(join(temporary, "lite-harness.db"), { force: true });
  cases.push(await runCase("mutable-runtime-image", {
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_RUNTIME_IMAGE: "lite-harness:latest",
  }, false, ["runtimeImage"]));
  cases.push(await runCase("missing-runtime-image", {
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_RUNTIME_IMAGE: `sha256:${"f".repeat(64)}`,
  }, false, ["runtimeImage"]));
  cases.push(await runCase("missing-production-dependencies", {
    LITE_HARNESS_MODE: "production",
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_PROVIDER: "openai-compatible",
  }, false, ["snapshotKey", "credentials", "runtimeImage", "gateway"]));
  cases.push(await runCase("missing-provider-credential", {
    LITE_HARNESS_PROVIDER: "openai-compatible",
  }, false, ["credentials"]));
  cases.push(await runCase("missing-snapshot-key", {
    LITE_HARNESS_MODE: "production", LITE_HARNESS_RUNTIME: "docker", LITE_HARNESS_PROVIDER: "openai-compatible",
    LITE_HARNESS_RUNTIME_IMAGE: `sha256:${"e".repeat(64)}`, LITE_HARNESS_PROVIDER_API_KEY: "doctor-placeholder-key",
  }, false, ["snapshotKey"]));
  cases.push(await runCase("low-disk", { LITE_HARNESS_DOCTOR_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) }, false, ["disk"]));
  cases.push(await runCase("invalid-snapshot-key", {
    LITE_HARNESS_MODE: "production", LITE_HARNESS_RUNTIME: "docker", LITE_HARNESS_PROVIDER: "openai-compatible",
    LITE_HARNESS_RUNTIME_IMAGE: `sha256:${"a".repeat(64)}`, LITE_HARNESS_SNAPSHOT_KEY: "not-a-base64-key",
    LITE_HARNESS_PROVIDER_API_KEY: "doctor-placeholder-key",
  }, false, ["snapshotKey"]));
  cases.push(await runCase("missing-docker", {
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_RUNTIME_IMAGE: `sha256:${"b".repeat(64)}`,
    LITE_HARNESS_DOCTOR_DOCKER_COMMAND: join(temporary, "docker-does-not-exist"),
  }, false, ["docker"]));
  cases.push(await runCase("wrong-docker-engine", {
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_RUNTIME_IMAGE: `sha256:${"c".repeat(64)}`,
    LITE_HARNESS_DOCTOR_DOCKER_COMMAND: badDockerCommand,
  }, false, ["docker"]));
  cases.push(await runCase("missing-active-docker-context", {
    LITE_HARNESS_RUNTIME: "docker", LITE_HARNESS_RUNTIME_IMAGE: `sha256:${"d".repeat(64)}`,
    LITE_HARNESS_DOCTOR_DOCKER_COMMAND: noContextDockerCommand,
  }, false, ["docker"]));
  cases.push(await runCase("invalid-config", { LITE_HARNESS_PROVIDER: "INVALID_PROVIDER" }, false, ["configuration"]));

  const migrationFailure = new DatabaseSync(join(temporary, "lite-harness.db"));
  migrationFailure.exec("CREATE TABLE workspaces(mode TEXT, registered_path TEXT); PRAGMA user_version = 999;");
  migrationFailure.close();
  cases.push(await runCase("migration-failure", {}, false, ["database"]));
  rmSync(join(temporary, "lite-harness.db"), { force: true });

  const locked = new DatabaseSync(join(temporary, "lite-harness.db"));
  locked.exec("CREATE TABLE workspaces(mode TEXT, registered_path TEXT); BEGIN EXCLUSIVE;");
  cases.push(await runCase("locked-database", {}, false, ["database"]));
  try { locked.exec("ROLLBACK"); } finally { locked.close(); }
  rmSync(join(temporary, "lite-harness.db"), { force: true });

  const unhealthyIpc = createServer((_request, response) => {
    response.statusCode = 503;
    response.end("not ready");
  });
  await new Promise((resolveReady) => unhealthyIpc.listen(0, "127.0.0.1", resolveReady));
  const address = unhealthyIpc.address();
  const port = typeof address === "object" && address ? address.port : 0;
  cases.push(await runCase("unhealthy-ipc", { LITE_HARNESS_DOCTOR_GATEWAY_URL: `http://127.0.0.1:${port}` }, false, ["gateway"]));
  await new Promise((resolveClosed) => unhealthyIpc.close(resolveClosed));

  const healthyReadiness = healthyGatewayReadiness();
  const { image: _omittedImage, ...incompleteDependencies } = healthyReadiness.dependencies.manager.dependencies;
  const readinessResponses = [
    { status: 200, body: healthyReadiness },
    { status: 200, raw: "<html>not gateway readiness</html>" },
    { status: 200, body: { ...healthyGatewayReadiness(), ok: false } },
    { status: 200, body: { ...healthyGatewayReadiness(), dependencies: {
      manager: { ...healthyGatewayReadiness().dependencies.manager, protocolVersion: "0" },
    } } },
    { status: 200, body: { ...healthyGatewayReadiness(), dependencies: {
      manager: { ...healthyGatewayReadiness().dependencies.manager, ok: false },
    } } },
    { status: 200, body: { ...healthyGatewayReadiness(), dependencies: {
      manager: { ...healthyGatewayReadiness().dependencies.manager, dependencies: incompleteDependencies },
    } } },
    { status: 200, body: { ...healthyGatewayReadiness(), dependencies: {
      manager: { ...healthyGatewayReadiness().dependencies.manager, dependencies: {
        ...healthyGatewayReadiness().dependencies.manager.dependencies,
        image: { ok: false, reason: "runtime-image-unavailable" },
      } },
    } } },
  ];
  const readinessIpc = createServer((_request, response) => {
    const fixture = readinessResponses.shift();
    response.statusCode = fixture?.status ?? 500;
    response.setHeader("content-type", "application/json");
    response.end(fixture && "raw" in fixture ? fixture.raw : JSON.stringify(fixture?.body ?? {}));
  });
  await new Promise((resolveReady) => readinessIpc.listen(0, "127.0.0.1", resolveReady));
  const readinessAddress = readinessIpc.address();
  const readinessPort = typeof readinessAddress === "object" && readinessAddress ? readinessAddress.port : 0;
  const readinessEnvironment = { LITE_HARNESS_DOCTOR_GATEWAY_URL: `http://127.0.0.1:${readinessPort}` };
  cases.push(await runCase("healthy-complete-ipc", readinessEnvironment, true));
  cases.push(await runCase("malformed-success-ipc", readinessEnvironment, false, ["gateway"]));
  cases.push(await runCase("false-success-ipc", readinessEnvironment, false, ["gateway"]));
  cases.push(await runCase("protocol-mismatch-ipc", readinessEnvironment, false, ["gateway"]));
  cases.push(await runCase("manager-false-success-ipc", readinessEnvironment, false, ["gateway"]));
  cases.push(await runCase("incomplete-manager-success-ipc", readinessEnvironment, false, ["gateway"]));
  cases.push(await runCase("contradictory-manager-success-ipc", readinessEnvironment, false, ["gateway"]));
  await new Promise((resolveClosed) => readinessIpc.close(resolveClosed));

  const database = new DatabaseSync(join(temporary, "lite-harness.db"));
  database.exec("PRAGMA user_version = 13; CREATE TABLE workspaces(mode TEXT, registered_path TEXT); INSERT INTO workspaces VALUES ('registered-bind', 'Z:/missing-lite-harness-root');");
  database.close();
  cases.push(await runCase("missing-registered-bind", {}, false, ["database"]));

  const assertions = Object.fromEntries(cases.map((item) => [item.name, (item.exitCode === 0) === item.expectedSuccess]));
  writePolicyEvidence({
    root,
    output: "evidence/m11/doctor.json",
    suite: "production-doctor",
    command: "pnpm check:doctor",
    assertions,
    qualificationResult: "pass",
    requirementIds: ["A14"],
    regressionIds: ["BD-059-REGRESSION"],
    sourcePath: "scripts/check-doctor.mjs",
    caseBindings: {
      A14: Object.keys(assertions),
      "BD-059-REGRESSION": Object.keys(assertions),
    },
    claims: {
      cases,
      missingRequiredCases: [],
    },
  });
  process.stdout.write(`Doctor checks passed (${cases.length}/${cases.length}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

async function runCase(name, overrides, expectSuccess, expectedRemediationChecks = []) {
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/cli/src/main.ts", "doctor"], {
      cwd: root,
      windowsHide: true,
      env: {
      ...process.env,
      LITE_HARNESS_DATA_DIR: temporary,
      LITE_HARNESS_CONFIG_VERSION: "1",
      LITE_HARNESS_INTERNAL_TOKEN: "doctor-internal-token",
      LITE_HARNESS_MODE: "development",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME_IMAGE: "",
      LITE_HARNESS_DOCTOR_GATEWAY_URL: "",
      LITE_HARNESS_SNAPSHOT_KEY: "",
      LITE_HARNESS_PROVIDER_API_KEY: "",
      ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("close", (status) => resolveResult({ status: status ?? -1, stdout, stderr }));
  });
  const passed = result.status === 0;
  if (passed !== expectSuccess) throw new Error(`${name} returned ${result.status}: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  if (expectSuccess && (report.remediation?.length ?? 0) !== 0) throw new Error(`${name} reported unexpected remediation: ${JSON.stringify(report.remediation)}`);
  if (!expectSuccess && (report.remediation?.length ?? 0) === 0) throw new Error(`${name} did not emit remediation details`);
  const reportedRemediationChecks = new Set((report.remediation ?? []).map((item) => item.check));
  for (const check of expectedRemediationChecks) {
    if (!reportedRemediationChecks.has(check)) throw new Error(`${name} did not emit ${check} remediation: ${JSON.stringify(report.remediation)}`);
    if (reportCheckHealthy(report, check)) throw new Error(`${name} reported ${check} healthy despite requiring remediation`);
  }
  return {
    name,
    expectedSuccess: expectSuccess,
    exitCode: result.status,
    reportedHealthy: requiredReportHealth(report),
    expectedRemediationChecks,
    reportedRemediationChecks: [...reportedRemediationChecks],
  };
}

function reportCheckHealthy(report, check) {
  if (check === "configuration") return report.configuration?.ok === true;
  if (check === "credentials") return report.credentials?.osStoreAvailable === true && report.credentials?.providerConfigured === true;
  if (check === "docker") return report.docker?.available === true && report.docker?.serverOs === "linux" &&
    (report.configuration?.runtime !== "docker" || Boolean(report.docker?.activeContext));
  return report[check]?.ok === true;
}

function healthyGatewayReadiness() {
  return {
    ok: true,
    role: "gateway",
    dependencies: {
      manager: {
        ok: true,
        role: "manager",
        protocolVersion: "1",
        dependencies: {
          database: { ok: true },
          disk: { ok: true },
          provider: { ok: true },
          snapshotKey: { ok: true },
          runtime: { ok: true },
          image: { ok: true },
        },
      },
    },
  };
}

function requiredReportHealth(report) {
  const dockerRequired = report.configuration?.mode === "production" || report.configuration?.runtime === "docker";
  return Boolean(report.node?.ok && (!dockerRequired || (report.docker?.available && report.docker?.serverOs === "linux" && report.docker?.activeContext)) && report.dataDirectory?.ok && report.disk?.ok &&
    report.database?.ok && report.runtimeImage?.ok && report.gateway?.ok && report.configuration?.ok && report.remediation?.length === 0);
}

function createBadDockerFixture(directory) {
  if (process.platform === "win32") {
    const path = join(directory, "docker-bad.cmd");
    writeFileSync(path, "@echo off\r\nif \"%1\"==\"version\" echo 26.0^|26.0\r\nif \"%1\"==\"context\" echo desktop-linux\r\nif \"%1\"==\"info\" echo {\"OSType\":\"windows\",\"Architecture\":\"amd64\"}\r\n", { mode: 0o700 });
    return path;
  }
  const path = join(directory, "docker-bad.sh");
  writeFileSync(path, "#!/bin/sh\ncase \"$1\" in version) printf '26.0|26.0\\n' ;; context) printf 'desktop-linux\\n' ;; info) printf '{\"OSType\":\"windows\",\"Architecture\":\"amd64\"}\\n' ;; esac\n", { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function createNoContextDockerFixture(directory) {
  if (process.platform === "win32") {
    const path = join(directory, "docker-no-context.cmd");
    writeFileSync(path, "@echo off\r\nif \"%1\"==\"version\" echo 26.0^|26.0\r\nif \"%1\"==\"info\" echo {\"OSType\":\"linux\",\"Architecture\":\"amd64\"}\r\n", { mode: 0o700 });
    return path;
  }
  const path = join(directory, "docker-no-context.sh");
  writeFileSync(path, "#!/bin/sh\ncase \"$1\" in version) printf '26.0|26.0\\n' ;; context) : ;; info) printf '{\"OSType\":\"linux\",\"Architecture\":\"amd64\"}\\n' ;; esac\n", { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
