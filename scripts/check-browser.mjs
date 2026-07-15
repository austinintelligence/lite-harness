import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-browser-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run", "test/browser-profile-isolation.test.ts", "test/browser-egress.test.ts", "test/browser-durability-artifacts.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Browser core suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m7-browser-core",
      command: "pnpm test:browser",
      report: evidenceReport,
      regressionIds: ["BD-009-REGRESSION", "BD-042-REGRESSION", "BD-043-REGRESSION"],
      claims: {
        boundaries: {
          ownerScopedProfilePath: true,
          ownerDerivedEncryptionKey: true,
          sameSlugIsolation: true,
          externalEgressBroker: true,
          chromiumInternalNetworkOnly: true,
          durableSessionsAndActions: true,
          authorizedStreamingArtifacts: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Browser core suite did not produce a zero-skip pass");
  process.stdout.write(`Browser core checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
