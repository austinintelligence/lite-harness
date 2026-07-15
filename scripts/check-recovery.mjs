import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-recovery-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run", "test/workspace.test.ts", "test/runtime.test.ts", "test/internal-boundary-schemas.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Workspace recovery suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m4-workspace-recovery",
      command: "pnpm test:recovery",
      report: evidenceReport,
      requirementIds: ["R21-1897", "R21-1899", "R21-1900", "R24-2069", "R24-2070", "R25-2100"],
      regressionIds: [
        "BD-015-REGRESSION", "BD-016-REGRESSION", "BD-017-REGRESSION",
        "BD-034-REGRESSION", "BD-035-REGRESSION",
      ],
      claims: {
        boundaries: {
          snapshotIdentityAuthenticatedAsAad: true,
          stagedGenerationVerifiedBeforeRotation: true,
          corruptCurrentDoesNotReplacePreviousGood: true,
          streamingAsyncCompressionEncryption: true,
          boundedStreamingRestore: true,
          artifactOwnerIsolation: true,
          privateCacheOwnerIsolation: true,
          registeredBindRootsCanonicalAndNonsensitive: true,
          artifactSourceReadFromOwnedWorkspace: true,
          artifactBlobEncryptedAndMetadataTransactional: true,
          artifactPublicAndInternalBoundariesRejectCallerBytes: true,
          artifactPromotionRequiresActiveWorkspaceLease: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Workspace recovery suite did not produce a zero-skip pass");
  process.stdout.write(`Workspace recovery checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
