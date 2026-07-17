import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { candidateEvidenceCatalogFailures } from "./assemble-ci-evidence.mjs";
import { validateEvidenceDocument } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const schemas = [
  readJson("schemas/release-evidence.schema.json"),
  readJson("schemas/alpha-ledger.schema.json"),
  readJson("schemas/defect-ledger.schema.json"),
  readJson("schemas/execution-ledger.schema.json"),
];
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);
const documents = [
  ["schemas/alpha-ledger.schema.json", "docs/requirements/alpha-ledger.yaml"],
  ["schemas/defect-ledger.schema.json", "docs/requirements/defect-ledger.yaml"],
  ["schemas/execution-ledger.schema.json", "docs/execution-ledger.json"],
  ["schemas/release-evidence.schema.json", "evidence/baseline/f9d522289b500174e4e387b6078f907ea4ac56fa/baseline.json"],
];
const failures = [];
for (const [schemaPath, documentPath] of documents) {
  const schema = schemas.find((candidate) => candidate.$id.endsWith(schemaPath.split("/").at(-1)));
  const validate = ajv.getSchema(schema.$id);
  if (!validate(readJson(documentPath))) failures.push(`${documentPath}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
}

let referencedCount = 0;
if (process.argv.includes("--referenced-evidence")) {
  const requirementLedger = readJson("docs/requirements/alpha-ledger.yaml");
  const defectLedger = readJson("docs/requirements/defect-ledger.yaml");
  const referenced = new Set();
  for (const row of requirementLedger.requirements) {
    for (const artifact of row.evidenceArtifacts ?? []) if (artifact?.path?.startsWith("evidence/m")) referenced.add(artifact.path);
  }
  for (const defect of defectLedger.defects) {
    const path = defect.regression?.evidenceArtifact?.path;
    if (path?.startsWith("evidence/m")) referenced.add(path);
  }
  referencedCount = referenced.size;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", `${head}^{tree}`], { cwd: root, encoding: "utf8" }).trim();
  const expectedCi = process.env.GITHUB_ACTIONS === "true"
    ? { workflow: process.env.GITHUB_WORKFLOW, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }
    : undefined;
  for (const path of [...referenced].sort()) {
    if (!existsSync(resolve(root, path))) {
      failures.push(`${path}: referenced candidate evidence is missing`);
      continue;
    }
    try {
      const document = readJson(path);
      const evidenceFailures = [
        ...validateEvidenceDocument(document, { expectedCommit: head, expectedTree: tree, requireClean: true }),
        ...candidateEvidenceCatalogFailures(path, document, { expectedCi }),
      ];
      if (evidenceFailures.length) failures.push(`${path}: ${evidenceFailures.join("; ")}`);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`Schema checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Schema checks passed for ${documents.length + referencedCount} authoritative documents.\n`);
}
