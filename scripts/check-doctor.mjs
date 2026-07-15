import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "lite-doctor-regression-"));
const cases = [];
try {
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
  const database = new DatabaseSync(join(temporary, "lite-harness.db"));
  database.exec("PRAGMA user_version = 13; CREATE TABLE workspaces(mode TEXT, registered_path TEXT); INSERT INTO workspaces VALUES ('registered-bind', 'Z:/missing-lite-harness-root');");
  database.close();
  cases.push(runCase("missing-registered-bind", {}, false));

  const evidencePath = resolve(root, "evidence/m11/doctor.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    commit,
    capturedAt: new Date().toISOString(),
    suite: "production-doctor",
    result: "pass",
    skips: 0,
    cases,
    testIds: ["BD-059-REGRESSION"],
  }, null, 2)}\n`);
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
  return { name, expectedSuccess: expectSuccess, exitCode: result.status, reportedHealthy: requiredReportHealth(report) };
}

function requiredReportHealth(report) {
  return Boolean(report.node?.ok && report.docker?.available && report.dataDirectory?.ok && report.disk?.ok &&
    report.database?.ok && report.runtimeImage?.ok && report.gateway?.ok);
}
