import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { writeVitestEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const toolImage = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");
const mcpImage = process.env.LITE_HARNESS_TEST_MCP_IMAGE?.trim() || toolImage;
const browserImage = requiredImage("LITE_HARNESS_TEST_BROWSER_IMAGE");
const requiredTestFiles = [
  "test/required-real-runtime.test.ts",
  "test/workspace.test.ts",
  "test/workspace-lifecycle.test.ts",
  "test/docker-runtime.integration.test.ts",
  "test/docker-workspace-lifecycle.integration.test.ts",
  "test/docker-mcp.integration.test.ts",
  "test/browser-integrations.test.ts",
];
assertLocallyAvailable(toolImage);
assertLocallyAvailable(mcpImage);
assertLocallyAvailable(browserImage);

const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceOutput = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
if (evidenceIndex >= 0 && (!evidenceOutput || evidenceOutput.startsWith("--"))) {
  throw new Error("--evidence requires an output path");
}

const temporary = mkdtempSync(resolve(tmpdir(), "lite-real-runtime-report-"));
const reportPath = resolve(temporary, "vitest.json");
try {
  const vitest = spawnSync(process.execPath, [
    resolve(root, "node_modules", "vitest", "vitest.mjs"), "run",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`,
  ], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      LITE_HARNESS_REAL_RUNTIME_TEST: "1",
      LITE_HARNESS_TEST_DOCKER_IMAGE: toolImage,
      LITE_HARNESS_TEST_MCP_IMAGE: mcpImage,
      LITE_HARNESS_TEST_BROWSER_IMAGE: browserImage,
    },
  });
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  if (!report) throw new Error("Real runtime suite did not produce JSON reporter output");
  const skips = report.numPendingTests + report.numTodoTests;
  const executedFiles = new Map((report.testResults ?? []).map((result) => [
    relative(root, result.name).replaceAll("\\", "/"), result,
  ]));
  const invalidRequiredFiles = requiredTestFiles.filter((path) => {
    const result = executedFiles.get(path);
    return !result || result.status !== "passed" || !result.assertionResults?.length ||
      result.assertionResults.some((test) => test.status !== "passed");
  });
  const passed = vitest.status === 0 && report.success === true && report.numFailedTests === 0 && skips === 0 &&
    report.numTotalTests >= 10 && invalidRequiredFiles.length === 0;
  const evidenceReport = { ...report, success: passed };
  if (evidenceOutput) {
    writeVitestEvidence({
      root,
      output: evidenceOutput,
      suite: "required-real-runtime",
      command: "pnpm test:real-runtime",
      report: evidenceReport,
      regressionIds: ["BD-047-REGRESSION", "BD-055-REGRESSION"],
      images: [
        imageArtifact("tool-runtime", toolImage),
        imageArtifact("mcp-runtime", mcpImage),
        imageArtifact("browser-runtime", browserImage),
      ],
      claims: {
        boundaries: {
          dockerToolExecution: true,
          coldWorkspaceRestore: true,
          isolatedMcpTransport: true,
          managedChromiumSidecar: true,
          browserUploadAndQuarantinedDownload: true,
          everyRequiredRuntimeFileExecuted: true,
        },
        executedFiles: requiredTestFiles,
      },
    });
  }
  if (!passed) {
    throw new Error(`Real runtime suite must pass every required file with at least 10 tests and zero skips (tests=${report.numTotalTests}, failures=${report.numFailedTests}, skips=${skips}, invalidFiles=${invalidRequiredFiles.join(",") || "none"})`);
  }
  process.stdout.write(`Real Docker and browser runtime checks passed (${report.numPassedTests}/${report.numTotalTests}, zero skips).\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function requiredImage(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must name a locally available immutable image digest or ID`);
  if (!value.startsWith("sha256:") && !/@sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${name} must be an immutable sha256 image ID or registry digest`);
  }
  return value;
}

function assertLocallyAvailable(image) {
  const inspected = spawnSync("docker", ["image", "inspect", image], { cwd: root, stdio: "ignore" });
  if (inspected.status !== 0) throw new Error(`Docker image is not locally available: ${image}`);
}

function imageArtifact(name, image) {
  const digest = /sha256:([a-f0-9]{64})$/i.exec(image)?.[1];
  if (!digest) throw new Error(`${name} must resolve to an immutable sha256 digest`);
  return { name, sha256: digest };
}
