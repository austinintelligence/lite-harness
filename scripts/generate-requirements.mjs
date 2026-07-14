import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BASELINE_COMMIT, PLAN_SHA256, extractRequirements } from "./requirements-lib.mjs";

const output = resolve(import.meta.dirname, "..", "docs", "requirements", "alpha-ledger.yaml");
mkdirSync(dirname(output), { recursive: true });
if (existsSync(output) && !process.argv.includes("--force")) {
  throw new Error(`${output} already exists; edit it deliberately or pass --force to rebuild the unverified baseline`);
}
const ledger = {
  schemaVersion: 1,
  baseline: { commit: BASELINE_COMMIT, branch: "lite-main", architectureContractSha256: PLAN_SHA256 },
  generatedFromFrozenContract: true,
  requirements: extractRequirements(),
};
writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(`Generated ${ledger.requirements.length} requirement rows at ${output}.\n`);
