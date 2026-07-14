import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASELINE_COMMIT, PLAN_PATH, PLAN_SHA256, extractRequirements } from "./requirements-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const ledgerPath = resolve(root, "docs", "requirements", "alpha-ledger.yaml");
const structureOnly = process.argv.includes("--structure");
const failures = [];
const planHash = createHash("sha256").update(readFileSync(PLAN_PATH)).digest("hex");
if (planHash !== PLAN_SHA256) failures.push(`architecture contract drifted: ${planHash}`);
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
if (ledger.schemaVersion !== 1) failures.push("alpha ledger schemaVersion must be 1");
if (ledger.baseline?.commit !== BASELINE_COMMIT) failures.push("alpha ledger baseline commit changed");
if (ledger.baseline?.architectureContractSha256 !== PLAN_SHA256) failures.push("alpha ledger contract hash changed");

const expected = new Map(extractRequirements().map((row) => [row.id, row]));
const actual = new Map();
for (const row of ledger.requirements ?? []) {
  if (actual.has(row.id)) failures.push(`duplicate requirement ${row.id}`);
  actual.set(row.id, row);
  for (const field of ["id", "kind", "title", "text", "owner", "source", "implementationPaths", "testIds", "ciJob", "evidenceArtifacts", "status", "blockers"]) {
    if (!(field in row)) failures.push(`${row.id ?? "unknown"} lacks ${field}`);
  }
  if (!Array.isArray(row.implementationPaths) || !Array.isArray(row.testIds) || !Array.isArray(row.evidenceArtifacts) || !Array.isArray(row.blockers)) {
    failures.push(`${row.id} has invalid traceability field types`);
  }
}
for (const [id, expectedRow] of expected) {
  const row = actual.get(id);
  if (!row) {
    failures.push(`missing required row ${id}`);
    continue;
  }
  if (row.text !== expectedRow.text) failures.push(`${id} requirement text drifted from its frozen source`);
  if (row.source?.section !== expectedRow.source.section || row.source?.lineStart !== expectedRow.source.lineStart) {
    failures.push(`${id} source locator drifted`);
  }
}
for (const id of actual.keys()) if (!expected.has(id)) failures.push(`unexpected requirement row ${id}`);

if (!structureOnly) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  for (const row of actual.values()) {
    if (!row.required) continue;
    if (row.status !== "verified") failures.push(`${row.id} is ${row.status}, not verified`);
    if (row.blockers.length) failures.push(`${row.id} has unresolved blockers: ${row.blockers.join(", ")}`);
    if (!row.implementationPaths.length) failures.push(`${row.id} lacks production implementation paths`);
    if (!row.testIds.length) failures.push(`${row.id} lacks runnable test IDs`);
    if (!row.ciJob) failures.push(`${row.id} lacks a CI job`);
    if (!row.evidenceArtifacts.length) failures.push(`${row.id} lacks current evidence artifacts`);
    for (const path of row.implementationPaths) if (!existsSync(resolve(root, path))) failures.push(`${row.id} implementation path is missing: ${path}`);
    for (const artifact of row.evidenceArtifacts) {
      if (!artifact?.path || !existsSync(resolve(root, artifact.path))) {
        failures.push(`${row.id} evidence artifact is missing: ${artifact?.path ?? "undefined"}`);
        continue;
      }
      try {
        const document = JSON.parse(readFileSync(resolve(root, artifact.path), "utf8"));
        if (document.commit !== head) failures.push(`${row.id} evidence is stale: ${document.commit ?? "no commit"} != ${head}`);
        if (document.result !== "pass" || document.skips !== 0 ||
            (Array.isArray(document.testIds) && !document.testIds.includes(row.id))) {
          failures.push(`${row.id} evidence is not a zero-skip pass: ${artifact.path}`);
        }
      } catch {
        failures.push(`${row.id} evidence is not valid JSON: ${artifact.path}`);
      }
    }
  }
}

if (failures.length) {
  process.stderr.write(`${structureOnly ? "Requirement structure" : "Release requirement"} checks failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${structureOnly ? "Requirement structure" : "Release requirement"} checks passed for ${actual.size} rows.\n`);
}
