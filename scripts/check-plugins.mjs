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

const temporary = mkdtempSync(resolve(tmpdir(), "lite-plugin-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "test/process-extensions.test.ts", "test/process-rpc-safety.test.ts", "test/plugin-lifecycle-manager.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Plugin/process extension suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m6-plugin-security",
      command: "pnpm test:plugins",
      report: evidenceReport,
      requirementIds: ["D25"],
      regressionIds: [
        "BD-007-REGRESSION", "BD-008-REGRESSION", "BD-025-REGRESSION",
        "BD-026-REGRESSION", "BD-027-REGRESSION",
      ],
      claims: {
        boundaries: {
          semanticVersionCoordinatesOnly: true,
          installAndUninstallRemainWithinRoot: true,
          executablePluginsFailClosedWithoutSandbox: true,
          sandboxReadOnly: true,
          sandboxNetworkDisabled: true,
          sandboxCapabilitiesDropped: true,
          sandboxResourceBounded: true,
          sandboxHostEnvironmentNotForwarded: true,
          delegatedWorkspaceOwnedAndFenced: true,
          delegatedManagedVolumesFailClosed: true,
          claudePromptUsesStdinNotArgv: true,
          preAbortedProcessNeverSpawns: true,
          timeoutReapsBeforeRejecting: true,
          partialJsonlBoundedBeforeNewline: true,
          abortListenersRemoved: true,
          childHomeIsolatedAndRemoved: true,
          managerOwnsLifecycleWrites: true,
          lazyStartRechecksPackageDigest: true,
          pluginToolCollisionsFailClosed: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Plugin/process extension suite did not produce a zero-skip pass");
  process.stdout.write(`Plugin/process extension checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
