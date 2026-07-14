import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDefectLedger } from "./defects-lib.mjs";

const output = resolve(import.meta.dirname, "..", "docs", "requirements", "defect-ledger.yaml");
mkdirSync(dirname(output), { recursive: true });
if (existsSync(output) && !process.argv.includes("--force")) throw new Error(`${output} already exists; pass --force only to rebuild the open baseline`);
const ledger = {
  schemaVersion: 1,
  baselineCommit: "f9d522289b500174e4e387b6078f907ea4ac56fa",
  closureRule: "A defect may close only when its regression test passes on the current commit with a zero-skip evidence artifact.",
  defects: createDefectLedger(),
};
writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(`Generated ${ledger.defects.length} baseline defect rows at ${output}.\n`);
