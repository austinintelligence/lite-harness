import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) {
  throw new Error("--evidence requires an output path");
}

const temporary = mkdtempSync(resolve(tmpdir(), "lite-provider-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "test/provider-core.test.ts",
    "test/provider-adapters.test.ts",
    "test/provider-cost-accounting.test.ts",
    "test/model-routing-persistence.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Provider conformance suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m5-provider-conformance",
      command: "pnpm test:providers",
      report: evidenceReport,
      requirementIds: ["R14-1251", "R27-2223", "R34-2883", "R14-1052", "R14-1281"],
      regressionIds: [
        "BD-030-REGRESSION", "BD-031-REGRESSION", "BD-032-REGRESSION",
        "BD-033-REGRESSION", "BD-039-REGRESSION",
      ],
      claims: {
        boundaries: {
          requiredCapabilitiesCheckedBeforeIo: true,
          retryOnlyBeforeVisibleSideEffect: true,
          requestAcceptanceAndUsageDisableFallback: true,
          providerResponsesBounded: true,
          unknownPricingRejectedUnderCostCeiling: true,
          omittedAdapterCostCalculatedFromFrozenRates: true,
          conservativeHigherCostEnforced: true,
          nativeOpenAiUsesResponsesApi: true,
          responsesTerminalStatesNormalized: true,
          openAiCompatibleRemainsSeparate: true,
          anthropicPlaintextRestrictedToLoopback: true,
          storedAgentCapabilitiesDriveFrozenRoutes: true,
          routePlansAndActualUsagePersisted: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Provider conformance suite did not produce a zero-skip pass");
  process.stdout.write(`Provider conformance checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
