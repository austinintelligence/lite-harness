import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { baselineDefects } from "./defects-lib.mjs";
import { currentCommit, currentTree, defectClosureFailures } from "./release-truth-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const structureOnly = process.argv.includes("--structure");
const closedOnly = process.argv.includes("--closed-only");
const ledger = JSON.parse(readFileSync(resolve(root, "docs", "requirements", "defect-ledger.yaml"), "utf8"));
const failures = [];
if (ledger.schemaVersion !== 1) failures.push("defect ledger schemaVersion must be 1");
if (ledger.baselineCommit !== "f9d522289b500174e4e387b6078f907ea4ac56fa") failures.push("defect baseline changed");
if (ledger.defects?.length !== baselineDefects.length) failures.push(`expected ${baselineDefects.length} defects, found ${ledger.defects?.length ?? 0}`);
const head = currentCommit(root);
const tree = currentTree(root, head);
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
    failures.push(...defectClosureFailures(defect, { root, head, tree, checkFreshness: !structureOnly })
      .map((failure) => `${defect.id} ${failure}`));
  }
}
if (!structureOnly && !closedOnly) {
  for (const defect of ledger.defects ?? []) if (["critical", "high"].includes(defect.severity) && defect.status !== "closed") failures.push(`${defect.id} ${defect.severity} defect remains ${defect.status}`);
}

if (failures.length) {
  const label = structureOnly ? "Defect structure" : closedOnly ? "Closed defect evidence" : "Release defect";
  process.stderr.write(`${label} checks failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  const label = structureOnly ? "Defect structure" : closedOnly ? "Closed defect evidence" : "Release defect";
  process.stdout.write(`${label} checks passed for ${ledger.defects.length} rows.\n`);
}
