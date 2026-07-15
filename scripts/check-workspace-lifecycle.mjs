import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const image = process.env.LITE_HARNESS_TEST_DOCKER_IMAGE?.trim();
if (!image) throw new Error("LITE_HARNESS_TEST_DOCKER_IMAGE must be a locally available immutable image digest or ID");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-workspace-lifecycle-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  execFileSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"), "run",
    "test/workspace.test.ts", "test/workspace-lifecycle.test.ts", "test/docker-workspace-lifecycle.integration.test.ts",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit", env: { ...process.env, LITE_HARNESS_TEST_DOCKER_IMAGE: image } });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) {
    throw new Error("Workspace lifecycle suite did not produce a zero-skip pass");
  }
  if (evidenceOutput) writeEvidence(evidenceOutput, report);
  process.stdout.write(`Workspace lifecycle checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }

function writeEvidence(output, report) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const document = {
    schemaVersion: 1, evidenceId: `m4-workspace-lifecycle-${commit.slice(0, 12)}-${platform()}-${arch()}`,
    commit, capturedAt: new Date().toISOString(),
    platform: { os: platform(), release: release(), architecture: arch(), node: process.version },
    suite: "m4-workspace-lifecycle", result: "pass", tests: report.numTotalTests,
    failures: report.numFailedTests, skips: report.numPendingTests + report.numTodoTests,
    boundaries: {
      coldRestoredBeforeRun: true, writerLeaseHeldThroughCheckpoint: true,
      snapshotVerifiedBeforeVolumeDelete: true, corruptedSnapshotFailsClosed: true,
      terminalStateAfterCheckpointAndLeaseRelease: true,
    },
    testIds: ["BD-015-REGRESSION", "BD-016-REGRESSION", "BD-017-REGRESSION", "BD-047-REGRESSION"],
  };
  const absolute = resolve(root, output); mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}
