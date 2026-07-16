import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) throw new Error("--evidence requires an output path");
const temporary = mkdtempSync(resolve(tmpdir(), "lite-optional-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"), "run", "test/optional-systems-manager.test.ts", "test/optional-packs.test.ts", "test/skill-lifecycle.test.ts", "test/mcp-isolation.test.ts", "test/cache-lifecycle.test.ts", "test/workspace-lifecycle.test.ts",
    "--reporter=json", `--outputFile=${reportPath}`,
  ], { cwd: root, stdio: "inherit" });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Optional-system composition suite did not produce JSON reporter output");
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "m9-optional-composition",
      command: "pnpm test:optional-systems",
      report: evidenceReport,
      requirementIds: [
        "A13", "D18", "D24", "R12-0894", "R12-0895", "R12-0896", "R12-0897", "R12-0909", "R12-0921",
        "R12-0928", "R12-0940", "R15-1408", "R15-1410", "R15-1411", "R15-1412", "R15-1413",
        "R15-1414", "R16-1497", "R16-1500", "R23-2014", "R23-2020", "R23-2021", "R23-2022",
        "R23-2024", "R23-2025", "R23-2026", "R23-2031", "R23-2032", "R23-2033", "R23-2035",
        "R25-2099", "R27-2182", "R27-2207", "R34-2875", "R34-2903", "R34-2907", "R34-2941",
        "R34-2951",
      ],
      regressionIds: [
        "BD-038-REGRESSION", "BD-044-REGRESSION", "BD-045-REGRESSION",
        "BD-046-REGRESSION", "BD-047-REGRESSION", "BD-049-REGRESSION",
      ],
      claims: {
        boundaries: {
          disabledPacksCreateNoToolsOrResources: true,
          contextCompiledAtRunBoundary: true,
          skillsFrozenAndLazy: true,
          mcpWorkersLazy: true,
          snapshotLifecycleAutomaticAndEncrypted: true,
          cacheKeysOwnerScoped: true,
        },
      },
    });
  }
  if (!passed) throw new Error("Optional-system composition suite did not produce a zero-skip pass");
  process.stdout.write(`Optional-system composition checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
