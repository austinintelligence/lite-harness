import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-context-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"), "run",
    "test/context-optimization.test.ts", "test/capabilities.test.ts", "test/provider-core.test.ts", "test/optional-systems-manager.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Context-optimization suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m10-context-optimization",
      command: "pnpm test:context",
      report: evidenceReport,
      requirementIds: [
        "D20", "D21", "D32", "P10", "R18-1660", "R18-1674", "R18-1675", "R18-1678", "R18-1682",
        "R18-1696", "R18-1697", "R18-1698", "R18-1699", "R18-1701", "R18-1702",
        "R18-1708", "R18-1709", "R18-1710", "R18-1711", "R18-1719", "R18-1720",
        "R18-1721", "R18-1722", "R18-1723", "R18-1730",
      ],
      regressionIds: ["BD-050-REGRESSION"],
      claims: {
        boundaries: {
          durableImmutableExactText: true,
          routeSelectedBeforeCompilation: true,
          visionCapabilityRequired: true,
          nativeLabelAndRecovery: true,
          providerMultimodalSerialization: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Context-optimization suite did not produce a zero-skip pass");
  process.stdout.write(`Context-optimization checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
