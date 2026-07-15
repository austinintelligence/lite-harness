import { spawnSync } from "node:child_process";
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
  cases.push(runCase("healthy-development", {}, true));
  writeFileSync(join(temporary, "lite-harness.db"), "not a database");
  cases.push(runCase("corrupt-database", {}, false));
  rmSync(join(temporary, "lite-harness.db"), { force: true });
  cases.push(runCase("mutable-runtime-image", {
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_RUNTIME_IMAGE: "lite-harness:latest",
  }, false));
  cases.push(runCase("missing-production-dependencies", {
    LITE_HARNESS_MODE: "production",
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_PROVIDER: "openai-compatible",
  }, false));
  cases.push(runCase("low-disk", { LITE_HARNESS_DOCTOR_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) }, false));
  cases.push(runCase("invalid-snapshot-key", {
    LITE_HARNESS_MODE: "production", LITE_HARNESS_RUNTIME: "docker", LITE_HARNESS_PROVIDER: "openai-compatible",
    LITE_HARNESS_RUNTIME_IMAGE: `sha256:${"a".repeat(64)}`, LITE_HARNESS_SNAPSHOT_KEY: "not-a-base64-key",
    LITE_HARNESS_PROVIDER_API_KEY: "doctor-placeholder-key",
  }, false));
  cases.push(runCase("bad-docker-context-or-version", { LITE_HARNESS_DOCTOR_DOCKER_COMMAND: badDockerCommand }, false));
  cases.push(runCase("invalid-config", { LITE_HARNESS_PROVIDER: "INVALID_PROVIDER" }, false));

  const migrationFailure = new DatabaseSync(join(temporary, "lite-harness.db"));
  migrationFailure.exec("PRAGMA user_version = 999;");
  migrationFailure.close();
  cases.push(runCase("migration-failure", {}, false));
  rmSync(join(temporary, "lite-harness.db"), { force: true });

  const locked = new DatabaseSync(join(temporary, "lite-harness.db"));
  locked.exec("CREATE TABLE workspaces(mode TEXT, registered_path TEXT); BEGIN EXCLUSIVE;");
  cases.push(runCase("locked-database", {}, false));
  try { locked.exec("ROLLBACK"); } finally { locked.close(); }
  rmSync(join(temporary, "lite-harness.db"), { force: true });

  const unhealthyIpc = createServer((_request, response) => {
    response.statusCode = 503;
    response.end("not ready");
  });
  await new Promise((resolveReady) => unhealthyIpc.listen(0, "127.0.0.1", resolveReady));
  const address = unhealthyIpc.address();
  const port = typeof address === "object" && address ? address.port : 0;
  cases.push(runCase("unhealthy-ipc", { LITE_HARNESS_DOCTOR_GATEWAY_URL: `http://127.0.0.1:${port}` }, false));
  await new Promise((resolveClosed) => unhealthyIpc.close(resolveClosed));

  const database = new DatabaseSync(join(temporary, "lite-harness.db"));
  database.exec("PRAGMA user_version = 13; CREATE TABLE workspaces(mode TEXT, registered_path TEXT); INSERT INTO workspaces VALUES ('registered-bind', 'Z:/missing-lite-harness-root');");
  database.close();
  cases.push(runCase("missing-registered-bind", {}, false));

  const assertions = Object.fromEntries(cases.map((item) => [item.name, (item.exitCode === 0) === item.expectedSuccess]));
  writePolicyEvidence({
    root,
    output: "evidence/m11/doctor.json",
    suite: "production-doctor",
    command: "pnpm check:doctor",
    assertions,
    qualificationResult: "pass",
    regressionIds: ["BD-059-REGRESSION"],
    sourcePath: "scripts/check-doctor.mjs",
    caseBindings: { "BD-059-REGRESSION": Object.keys(assertions) },
    claims: {
      cases,
      missingRequiredCases: [],
    },
  });
  process.stdout.write(`Doctor checks passed (${cases.length}/${cases.length}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function runCase(name, overrides, expectSuccess) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "apps/cli/src/main.ts", "doctor"], {
    cwd: root,
    encoding: "utf8",
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
  });
  const passed = result.status === 0;
  if (passed !== expectSuccess) throw new Error(`${name} returned ${result.status}: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  if (expectSuccess && (report.remediation?.length ?? 0) !== 0) throw new Error(`${name} reported unexpected remediation: ${JSON.stringify(report.remediation)}`);
  if (!expectSuccess && (report.remediation?.length ?? 0) === 0) throw new Error(`${name} did not emit remediation details`);
  return { name, expectedSuccess: expectSuccess, exitCode: result.status, reportedHealthy: requiredReportHealth(report) };
}

function requiredReportHealth(report) {
  return Boolean(report.node?.ok && report.docker?.available && report.dataDirectory?.ok && report.disk?.ok &&
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
