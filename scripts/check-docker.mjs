import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-docker-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  execFileSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run", "test/docker-archive.test.ts", "test/docker-lifecycle.test.ts", "test/runtime.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) {
    throw new Error("Docker policy suite did not produce a zero-skip pass");
  }
  if (evidenceOutput) writeEvidence(evidenceOutput, report);
  process.stdout.write(`Docker policy checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function writeEvidence(output, report) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const document = {
    schemaVersion: 1,
    evidenceId: `m3-docker-policy-${commit.slice(0, 12)}-${platform()}-${arch()}`,
    commit,
    capturedAt: new Date().toISOString(),
    platform: { os: platform(), release: release(), architecture: arch(), node: process.version },
    suite: "m3-docker-policy",
    result: "pass",
    tests: report.numTotalTests,
    failures: report.numFailedTests,
    skips: report.numPendingTests + report.numTodoTests,
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
    testIds: ["BD-018-REGRESSION", "BD-019-REGRESSION", "BD-020-REGRESSION", "BD-040-REGRESSION", "BD-041-REGRESSION"],
  };
  const absolute = resolve(root, output);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}
