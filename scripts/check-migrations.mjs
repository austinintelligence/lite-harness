import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) {
  throw new Error("--evidence requires an output path");
}
const temporary = mkdtempSync(resolve(tmpdir(), "lite-migration-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  execFileSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "test/migrations.test.ts",
    "test/idempotency.test.ts",
    "test/owner-scoped-identities.test.ts",
    "test/session-history.test.ts",
    "test/queue-deadline.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) {
    throw new Error("Migration suite did not produce a zero-skip pass");
  }
  if (evidenceOutput) writeEvidence(evidenceOutput, report);
  process.stdout.write(`Migration checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function writeEvidence(output, report) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const document = {
    schemaVersion: 1,
    evidenceId: `m2-migrations-${commit.slice(0, 12)}-${platform()}-${arch()}`,
    commit,
    capturedAt: new Date().toISOString(),
    platform: { os: platform(), release: release(), architecture: arch(), node: process.version },
    suite: "m2-migrations",
    result: "pass",
    tests: report.numTotalTests,
    failures: report.numFailedTests,
    skips: report.numPendingTests + report.numTodoTests,
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
    },
    testIds: [
      "BD-010-REGRESSION", "BD-011-REGRESSION", "BD-012-REGRESSION", "BD-013-REGRESSION",
      "BD-014-REGRESSION", "BD-024-REGRESSION", "R29-2320",
    ],
  };
  const absolute = resolve(root, output);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}
