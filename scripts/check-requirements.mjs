import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { currentCommit, currentTree, requirementVerificationFailures } from "./release-truth-lib.mjs";
import { BASELINE_COMMIT, PLAN_PATH, PLAN_SHA256, extractRequirements } from "./requirements-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const ledgerPath = resolve(root, "docs", "requirements", "alpha-ledger.yaml");
const structureOnly = process.argv.includes("--structure");
const verifiedOnly = process.argv.includes("--verified-only");
const failures = [];
const planHash = createHash("sha256").update(readFileSync(PLAN_PATH)).digest("hex");
if (planHash !== PLAN_SHA256) failures.push(`architecture contract drifted: ${planHash}`);
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
if (ledger.schemaVersion !== 2) failures.push("alpha ledger schemaVersion must be 2");
if (ledger.baseline?.commit !== BASELINE_COMMIT) failures.push("alpha ledger baseline commit changed");
if (ledger.baseline?.architectureContractSha256 !== PLAN_SHA256) failures.push("alpha ledger contract hash changed");
for (const tier of ["alpha", "preview", "beta", "future"]) {
  if (!ledger.tiers?.[tier] || typeof ledger.tiers[tier].releaseRequired !== "boolean" || typeof ledger.tiers[tier].description !== "string") {
    failures.push(`alpha ledger tier definition is missing or invalid: ${tier}`);
  }
}

const expected = new Map(extractRequirements().map((row) => [row.id, row]));
const actual = new Map();
for (const row of ledger.requirements ?? []) {
  if (actual.has(row.id)) failures.push(`duplicate requirement ${row.id}`);
  actual.set(row.id, row);
  for (const field of ["id", "kind", "tier", "title", "text", "owner", "source", "implementationPaths", "testIds", "ciJob", "evidenceArtifacts", "status", "blockers"]) {
    if (!(field in row)) failures.push(`${row.id ?? "unknown"} lacks ${field}`);
  }
  if (!["alpha", "preview", "beta", "future"].includes(row.tier)) failures.push(`${row.id} has invalid tier`);
  if (typeof row.required !== "boolean") failures.push(`${row.id} has invalid required flag`);
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
  if (row.tier !== expectedRow.tier) failures.push(`${id} tier drifted from the frozen alpha scope classification`);
  if (row.required !== expectedRow.required) failures.push(`${id} required flag must match its tier`);
  if (row.source?.section !== expectedRow.source.section || row.source?.lineStart !== expectedRow.source.lineStart) {
    failures.push(`${id} source locator drifted`);
  }
}
for (const id of actual.keys()) if (!expected.has(id)) failures.push(`unexpected requirement row ${id}`);

if (!structureOnly) {
  const head = currentCommit(root);
  const tree = currentTree(root, head);
  for (const row of actual.values()) {
    if (!row.required) continue;
    if (verifiedOnly && row.status !== "verified") continue;
    failures.push(...requirementVerificationFailures(row, { root, head, tree }).map((failure) => `${row.id} ${failure}`));
  }
}

if (failures.length) {
  const label = structureOnly ? "Requirement structure" : verifiedOnly ? "Verified requirement evidence" : "Release requirement";
  process.stderr.write(`${label} checks failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  const label = structureOnly ? "Requirement structure" : verifiedOnly ? "Verified requirement evidence" : "Release requirement";
  process.stdout.write(`${label} checks passed for ${actual.size} rows.\n`);
}
