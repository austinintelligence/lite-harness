import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-docker-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run", "test/docker-archive.test.ts", "test/docker-lifecycle.test.ts", "test/runtime.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Docker policy suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m3-docker-policy",
      command: "pnpm test:docker",
      report: evidenceReport,
      requirementIds: [
        "D04", "D15", "D16", "R07-0553", "R19-1822", "R19-1824", "R19-1825", "R19-1826", "R19-1828", "R19-1829",
      ],
      regressionIds: ["BD-018-REGRESSION", "BD-019-REGRESSION", "BD-020-REGRESSION", "BD-040-REGRESSION", "BD-041-REGRESSION"],
      claims: {
        boundaries: {
          boundedTarEntries: true,
          traversalAndLinksDenied: true,
          checksumsAndFramingValidated: true,
          maintenanceRootfsReadOnly: true,
          maintenanceNetworkDisabled: true,
          maintenanceCapabilitiesMinimal: true,
          maintenanceResourcesBounded: true,
          toolContainerIdentityPersistedBeforeStart: true,
          toolContainerOwnershipLabelsScoped: true,
          startupContainerReconciliation: true,
          cancellationIndependentlyKillsWaitsRemovesAndVerifies: true,
          boundedCodingToolSurface: true,
          codingImageProfilePinnedAndNonRoot: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Docker policy suite did not produce a zero-skip pass");
  process.stdout.write(`Docker policy checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
