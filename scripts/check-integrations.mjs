import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-integration-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run", "test/gateway-manager.e2e.test.ts", "test/internal-boundary-schemas.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Integration authenticity suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m8-integration-authenticity",
      command: "pnpm test:integrations",
      report: evidenceReport,
      requirementIds: ["R32-2505"],
      regressionIds: ["BD-036-REGRESSION", "BD-037-REGRESSION"],
      claims: {
        boundaries: {
          webhookHmacCoversExactIngressBytes: true,
          gatewayPreservesExactBytesOverIpc: true,
          reserializedEquivalentJsonRejected: true,
          normalizedEnvelopeParsedOnlyAfterAuthentication: true,
          publicAndInternalRequestsUseAuthoritativeSchemas: true,
          unknownFieldsAndMalformedBase64Rejected: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Integration authenticity suite did not produce a zero-skip pass");
  process.stdout.write(`Integration authenticity checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
