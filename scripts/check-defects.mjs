import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { baselineDefects } from "./defects-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const structureOnly = process.argv.includes("--structure");
const ledger = JSON.parse(readFileSync(resolve(root, "docs", "requirements", "defect-ledger.yaml"), "utf8"));
const failures = [];
if (ledger.schemaVersion !== 1) failures.push("defect ledger schemaVersion must be 1");
if (ledger.baselineCommit !== "f9d522289b500174e4e387b6078f907ea4ac56fa") failures.push("defect baseline changed");
if (ledger.defects?.length !== baselineDefects.length) failures.push(`expected ${baselineDefects.length} defects, found ${ledger.defects?.length ?? 0}`);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const seen = new Set();
for (let index = 0; index < (ledger.defects ?? []).length; index += 1) {
  const defect = ledger.defects[index];
  const expectedId = `BD-${String(index + 1).padStart(3, "0")}`;
  if (defect.id !== expectedId) failures.push(`expected ${expectedId} at index ${index}, found ${defect.id}`);
  if (seen.has(defect.id)) failures.push(`duplicate defect ${defect.id}`);
  seen.add(defect.id);
  for (const field of ["title", "description", "severity", "category", "source", "status", "reproduction", "regression", "fixCommits", "blockers"]) {
    if (!(field in defect)) failures.push(`${defect.id} lacks ${field}`);
  }
  if (defect.severity !== (index < 8 ? "critical" : "high")) failures.push(`${defect.id} severity drifted`);
  if (defect.status === "closed") {
    if (!defect.regression?.path || !existsSync(resolve(root, defect.regression.path))) failures.push(`${defect.id} closed without a regression test file`);
    if (defect.regression?.result !== "pass") failures.push(`${defect.id} closed without a passing regression`);
    const evidence = defect.regression?.evidenceArtifact;
    if (!evidence?.path) failures.push(`${defect.id} closed without a regression evidence path`);
    if (!structureOnly && (!evidence?.path || !existsSync(resolve(root, evidence.path)))) {
      failures.push(`${defect.id} closed without current zero-skip evidence`);
    } else if (!structureOnly && evidence?.path) {
      try {
        const document = JSON.parse(readFileSync(resolve(root, evidence.path), "utf8"));
        if (document.commit !== head || document.result !== "pass" || document.skips !== 0 ||
            !Array.isArray(document.testIds) || !document.testIds.includes(defect.regression.testId)) {
          failures.push(`${defect.id} closed without current zero-skip evidence`);
        }
      } catch {
        failures.push(`${defect.id} regression evidence is not valid JSON`);
      }
    }
    if (defect.blockers?.length) failures.push(`${defect.id} closed with blockers`);
  }
}
if (!structureOnly) {
  for (const defect of ledger.defects ?? []) if (["critical", "high"].includes(defect.severity) && defect.status !== "closed") failures.push(`${defect.id} ${defect.severity} defect remains ${defect.status}`);
}

if (failures.length) {
  process.stderr.write(`${structureOnly ? "Defect structure" : "Release defect"} checks failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${structureOnly ? "Defect structure" : "Release defect"} checks passed for ${ledger.defects.length} rows.\n`);
}
