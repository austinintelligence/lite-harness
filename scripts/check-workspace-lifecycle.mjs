import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const image = process.env.LITE_HARNESS_TEST_DOCKER_IMAGE?.trim();
if (!image) throw new Error("LITE_HARNESS_TEST_DOCKER_IMAGE must be a locally available immutable image digest or ID");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-workspace-lifecycle-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"), "run",
    "test/workspace.test.ts", "test/workspace-lifecycle.test.ts", "test/docker-workspace-lifecycle.integration.test.ts",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit", env: { ...process.env, LITE_HARNESS_REAL_RUNTIME_TEST: "1", LITE_HARNESS_TEST_DOCKER_IMAGE: image } });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Workspace lifecycle suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m4-workspace-lifecycle",
      command: "pnpm test:workspace-lifecycle",
      report: evidenceReport,
      requirementIds: [
        "A10", "D17", "R07-0488", "R22-1941", "R22-1942", "R22-1948", "R22-1949", "R22-1950",
        "R22-1951", "R22-1958", "R26-2152", "R27-2181", "R27-2208", "R34-2877", "R34-2897",
      ],
      regressionIds: ["BD-015-REGRESSION", "BD-016-REGRESSION", "BD-017-REGRESSION", "BD-047-REGRESSION"],
      claims: {
        boundaries: {
          coldRestoredBeforeRun: true,
          writerLeaseHeldThroughCheckpoint: true,
          snapshotVerifiedBeforeVolumeDelete: true,
          corruptedSnapshotFailsClosed: true,
          terminalStateAfterCheckpointAndLeaseRelease: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Workspace lifecycle suite did not produce a zero-skip pass");
  process.stdout.write(`Workspace lifecycle checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
