import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const batches = {
  critical: {
    ids: Array.from({ length: 8 }, (_, index) => `BD-${String(index + 1).padStart(3, "0")}`),
    testPath: "test/reproduction/critical.repro.ts",
    evidencePath: "docs/evidence/defects/critical-reproduction.json",
  },
};

const name = process.argv[2];
const batch = batches[name];
if (!batch) throw new Error(`Unknown defect reproduction batch: ${name ?? "<missing>"}`);

const temporary = mkdtempSync(join(tmpdir(), "lite-defect-report-"));
const rawPath = join(temporary, "vitest.json");
try {
  const result = spawnSync(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.reproduction.config.ts",
    batch.testPath,
    "--reporter=json",
    `--outputFile=${rawPath}`,
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 1) {
    throw new Error(`Reproduction tests must fail with status 1; received ${result.status ?? "no status"}\n${result.stderr}`);
  }

  const report = JSON.parse(readFileSync(rawPath, "utf8"));
  const assertions = report.testResults.flatMap((testFile) => testFile.assertionResults);
  const reproduced = assertions.map((assertion) => {
    const id = /\bBD-\d{3}-REPRO\b/.exec(assertion.title)?.[0].replace("-REPRO", "");
    if (!id) throw new Error(`Reproduction test lacks a defect id: ${assertion.title}`);
    return {
      id,
      testId: `${id}-REPRO`,
      status: assertion.status,
      observed: asciiFirstLine(assertion.failureMessages?.[0] ?? "missing failure message"),
    };
  });
  const actualIds = reproduced.filter((item) => item.status === "failed").map((item) => item.id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify([...batch.ids].sort())) {
    throw new Error(`Expected failing reproductions ${batch.ids.join(", ")}; observed ${actualIds.join(", ")}`);
  }

  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const testSha256 = createHash("sha256").update(readFileSync(resolve(root, batch.testPath))).digest("hex");
  const evidence = {
    schemaVersion: 1,
    batch: name,
    baselineCommit: "f9d522289b500174e4e387b6078f907ea4ac56fa",
    sourceCommit,
    recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    command: `pnpm reproduce:defects:${name}`,
    testPath: batch.testPath,
    testSha256,
    expectedFailures: batch.ids.length,
    observedFailures: actualIds.length,
    skips: 0,
    results: reproduced,
  };
  const evidenceFile = resolve(root, batch.evidencePath);
  mkdirSync(dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

  const ledgerPath = resolve(root, "docs/requirements/defect-ledger.yaml");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  for (const id of batch.ids) {
    const defect = ledger.defects.find((item) => item.id === id);
    if (!defect) throw new Error(`Defect ledger is missing ${id}`);
    defect.status = "reproduced";
    defect.reproduction = {
      testId: `${id}-REPRO`,
      path: batch.testPath,
      result: "reproduced",
      evidenceArtifact: {
        path: batch.evidencePath,
        sourceCommit,
        testSha256,
        skips: 0,
      },
    };
    defect.blockers = ["regression-fix-required"];
  }
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(`Reproduced ${actualIds.length} defects in ${batch.testPath}; evidence: ${batch.evidencePath}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function asciiFirstLine(message) {
  return message.split(/\r?\n/, 1)[0].replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
}
