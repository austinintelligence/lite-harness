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
const temporary = mkdtempSync(resolve(tmpdir(), "lite-migration-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "test/migrations.test.ts",
    "test/idempotency.test.ts",
    "test/owner-scoped-identities.test.ts",
    "test/session-history.test.ts",
    "test/queue-deadline.test.ts",
    "test/transactional-projections.test.ts",
    "test/lifecycle-safety.test.ts",
    "test/agent-runtime.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Migration suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m2-migrations",
      command: "pnpm test:migrations",
      report: evidenceReport,
      requirementIds: ["D11", "D12", "D13", "D14", "R29-2320"],
      regressionIds: [
        "BD-002-REGRESSION", "BD-003-REGRESSION", "BD-004-REGRESSION", "BD-005-REGRESSION",
        "BD-010-REGRESSION", "BD-011-REGRESSION", "BD-012-REGRESSION", "BD-013-REGRESSION",
        "BD-014-REGRESSION", "BD-024-REGRESSION", "BD-021-REGRESSION",
      ],
      claims: {
        boundaries: {
          actualV1DatabaseFixture: true,
          orderedTransactions: true,
          dataPreserved: true,
          gapAndFutureVersionFailClosed: true,
          userScopedIdempotency: true,
          canonicalRequestFingerprint: true,
          ownerScopedExternalSlugs: true,
          opaqueInternalIdentityReferences: true,
          newestSessionHistoryWindow: true,
          structuredAssistantToolCalls: true,
          acceptedToTerminalDeadline: true,
          atomicEventProjectionAndAttempt: true,
          renewableFencedWorkspaceLease: true,
          terminalAfterCleanup: true,
          boundedManagerDrain: true,
          nonCooperativeProviderCleanupBounded: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Migration suite did not produce a zero-skip pass");
  process.stdout.write(`Migration checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
