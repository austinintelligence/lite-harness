import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence"); const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-run-snapshot-report-")); const reportPath = resolve(temporary, "vitest.json");
try {
  execFileSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"), "run", "test/run-snapshot.test.ts", "test/model-routing-persistence.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) throw new Error("RunSnapshot suite did not produce a zero-skip pass");
  if (evidenceOutput) {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const document = {
      schemaVersion: 1, evidenceId: `m9-run-snapshot-${commit.slice(0, 12)}-${platform()}-${arch()}`, commit, capturedAt: new Date().toISOString(),
      platform: { os: platform(), release: release(), architecture: arch(), node: process.version }, suite: "m9-run-snapshot",
      result: "pass", tests: report.numTotalTests, failures: report.numFailedTests, skips: report.numPendingTests + report.numTodoTests,
      boundaries: { frozenBeforeFirstModelTurn: true, immutablePerAttempt: true, exactToolsSkillsPluginsAndPolicies: true, credentialIdsOnly: true },
      testIds: ["BD-039-REGRESSION", "BD-048-REGRESSION"],
    };
    const absolute = resolve(root, evidenceOutput); mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`RunSnapshot checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
