import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BASELINE_COMMIT, PLAN_SHA256, extractRequirements } from "./requirements-lib.mjs";

const output = resolve(import.meta.dirname, "..", "docs", "requirements", "alpha-ledger.yaml");
mkdirSync(dirname(output), { recursive: true });
if (existsSync(output) && !process.argv.includes("--force")) {
  throw new Error(`${output} already exists; edit it deliberately or pass --force to rebuild the unverified baseline`);
}
const previous = existsSync(output)
  ? JSON.parse(readFileSync(output, "utf8"))
  : { requirements: [] };
const previousById = new Map((previous.requirements ?? []).map((row) => [row.id, row]));
const requirements = extractRequirements().map((row) => {
  const prior = previousById.get(row.id);
  return {
    ...row,
    implementationPaths: prior?.implementationPaths ?? row.implementationPaths,
    testIds: prior?.testIds ?? row.testIds,
    ciJob: prior?.ciJob ?? row.ciJob,
    evidenceArtifacts: prior?.evidenceArtifacts ?? row.evidenceArtifacts,
    status: prior?.status ?? row.status,
    blockers: prior?.blockers ?? row.blockers,
  };
});
const ledger = {
  schemaVersion: 2,
  baseline: { commit: BASELINE_COMMIT, branch: "lite-main", architectureContractSha256: PLAN_SHA256 },
  generatedFromFrozenContract: true,
  tiers: {
    alpha: { releaseRequired: true, description: "Required for the local alpha candidate." },
    preview: { releaseRequired: false, description: "Implemented or specified preview surface; excluded from alpha qualification." },
    beta: { releaseRequired: false, description: "Beta roadmap surface; excluded from alpha qualification." },
    future: { releaseRequired: false, description: "Future or optional design surface; excluded from alpha qualification." },
  },
  requirements,
};
writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(`Generated ${ledger.requirements.length} requirement rows at ${output}.\n`);
