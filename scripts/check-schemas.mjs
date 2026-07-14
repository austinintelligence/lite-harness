import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const schemas = [
  readJson("schemas/release-evidence.schema.json"),
  readJson("schemas/alpha-ledger.schema.json"),
  readJson("schemas/defect-ledger.schema.json"),
];
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);
const documents = [
  ["schemas/alpha-ledger.schema.json", "docs/requirements/alpha-ledger.yaml"],
  ["schemas/defect-ledger.schema.json", "docs/requirements/defect-ledger.yaml"],
  ["schemas/release-evidence.schema.json", "evidence/baseline/f9d522289b500174e4e387b6078f907ea4ac56fa/baseline.json"],
];
const failures = [];
for (const [schemaPath, documentPath] of documents) {
  const schema = schemas.find((candidate) => candidate.$id.endsWith(schemaPath.split("/").at(-1)));
  const validate = ajv.getSchema(schema.$id);
  if (!validate(readJson(documentPath))) failures.push(`${documentPath}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
}
if (failures.length) {
  process.stderr.write(`Schema checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Schema checks passed for ${documents.length} authoritative documents.\n`);
}
