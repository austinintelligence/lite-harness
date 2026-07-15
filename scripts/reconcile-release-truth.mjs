import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { currentCommit, currentTree, defectClosureFailures, requirementVerificationFailures } from "./release-truth-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const requirementPath = resolve(root, "docs", "requirements", "alpha-ledger.yaml");
const defectPath = resolve(root, "docs", "requirements", "defect-ledger.yaml");
const requirements = JSON.parse(readFileSync(requirementPath, "utf8"));
const defects = JSON.parse(readFileSync(defectPath, "utf8"));
const head = currentCommit(root);
const tree = currentTree(root, head);
let demotedRequirements = 0;
let reopenedDefects = 0;

for (const row of requirements.requirements) {
  if (row.status !== "verified") continue;
  const failures = requirementVerificationFailures(row, { root, head, tree });
  if (!failures.length) continue;
  row.status = "blocked";
  row.blockers = [...new Set([...row.blockers, ...requirementBlockers(failures)])];
  demotedRequirements += 1;
}

for (const defect of defects.defects) {
  if (defect.status !== "closed") continue;
  const failures = defectClosureFailures(defect, { root, head, tree });
  if (!failures.length) continue;
  defect.status = "fix-in-progress";
  defect.blockers = [...new Set([
    ...defect.blockers,
    "current-regression-evidence-missing",
    ...(["BD-035", "BD-059", "BD-061"].includes(defect.id) ? ["substantive-regression-gap"] : []),
  ])];
  reopenedDefects += 1;
}

writeFileSync(requirementPath, `${JSON.stringify(requirements, null, 2)}\n`);
writeFileSync(defectPath, `${JSON.stringify(defects, null, 2)}\n`);
process.stdout.write(`Demoted ${demotedRequirements} unsupported requirement claims and reopened ${reopenedDefects} unproven defect closures.\n`);

function requirementBlockers(failures) {
  const blockers = [];
  if (failures.some((failure) => failure.includes("stale"))) blockers.push("current-evidence-stale");
  if (failures.some((failure) => failure.includes("does not name requirement"))) blockers.push("evidence-requirement-coverage-missing");
  if (failures.some((failure) => failure.includes("zero-skip"))) blockers.push("zero-skip-evidence-missing");
  if (failures.some((failure) => failure.includes("missing") || failure.includes("valid JSON"))) blockers.push("current-evidence-invalid-or-missing");
  return blockers.length ? blockers : ["current-evidence-invalid-or-missing"];
}
