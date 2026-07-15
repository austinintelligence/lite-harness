import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const toolImage = requiredImage("LITE_HARNESS_TEST_DOCKER_IMAGE");
const mcpImage = process.env.LITE_HARNESS_TEST_MCP_IMAGE?.trim() || toolImage;
const browserImage = requiredImage("LITE_HARNESS_TEST_BROWSER_IMAGE");
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
  execFileSync(process.execPath, [
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
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const skips = report.numPendingTests + report.numTodoTests;
  if (report.success !== true || report.numFailedTests !== 0 || skips !== 0 || report.numTotalTests < 10) {
    throw new Error(`Real runtime suite must pass at least 10 tests with zero skips (tests=${report.numTotalTests}, failures=${report.numFailedTests}, skips=${skips})`);
  }
  if (evidenceOutput) writeEvidence(evidenceOutput, report, { toolImage, mcpImage, browserImage });
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
  execFileSync("docker", ["image", "inspect", image], { cwd: root, stdio: "ignore" });
}

function writeEvidence(output, report, images) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const absolute = resolve(root, output);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify({
    schemaVersion: 1,
    evidenceId: `real-runtime-${commit.slice(0, 12)}-${platform()}-${arch()}`,
    commit,
    capturedAt: new Date().toISOString(),
    platform: { os: platform(), release: release(), architecture: arch(), node: process.version },
    suite: "required-real-runtime",
    result: "pass",
    tests: report.numTotalTests,
    failures: report.numFailedTests,
    skips: report.numPendingTests + report.numTodoTests,
    images,
    boundaries: {
      dockerToolExecution: true,
      coldWorkspaceRestore: true,
      isolatedMcpTransport: true,
      managedChromiumSidecar: true,
      browserUploadAndQuarantinedDownload: true,
    },
    testIds: ["BD-047-REGRESSION", "BD-055-REGRESSION"],
  }, null, 2)}\n`, { mode: 0o600 });
}
