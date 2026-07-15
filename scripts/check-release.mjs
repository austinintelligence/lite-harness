import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { writePolicyEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const required = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "UPSTREAM.md", "BLOCKERS.md",
  "PROVENANCE.json", "THIRD_PARTY_NOTICES.md", "docs/ARCHITECTURE.md",
  "docs/API.md", "docs/BROWSER.md", "docs/INTEGRATIONS.md", "docs/THREAT_MODEL.md", "docs/RECOVERY.md",
  "docs/OPERATIONS.md", "docs/TESTING.md", "docs/CONTEXT_OPTIMIZATION.md", "docs/SUBAGENTS_AND_MEMORY.md",
  "docs/MIGRATION.md", "docs/IMPLEMENTATION_STATUS.md", "docs/openapi.json", "docs/sbom.cdx.json",
  "docs/adr/README.md", "docs/adr/RESEARCH.md", "docs/adr/0001-node-typescript-stack.md",
  "docs/adr/0032-behavior-defined-compatibility.md", "docs/adr/0052-alpha-scope-and-preview-boundaries.md",
  "docs/requirements/alpha-ledger.yaml", "docs/requirements/defect-ledger.yaml",
  "docs/requirements/BASELINE_DRIFT.md",
  "evidence/baseline/0bcdb123335e5883d66287643b22ab707d2893bb/drift.json",
  "docs/performance-baseline.json", "docs/pxpipe-evaluation.json", "docs/pxpipe-paired-evaluation.json",
  "schemas/alpha-ledger.schema.json", "schemas/defect-ledger.schema.json", "schemas/release-evidence.schema.json",
  "evidence/baseline/f9d522289b500174e4e387b6078f907ea4ac56fa/baseline.json",
  ".github/workflows/ci.yml", ".github/workflows/images.yml", ".gitattributes", ".gitignore",
  "docker/tool-runtime/Dockerfile", "docker/tool-runtime/.dockerignore",
  "docker/browser-runtime/Dockerfile", "docker/browser-runtime/.dockerignore", "sdks/python/pyproject.toml",
];
const failures = required.filter((file) => !existsSync(resolve(root, file))).map((file) => `missing ${file}`);

if (existsSync(resolve(root, "docs/openapi.json"))) JSON.parse(readFileSync(resolve(root, "docs/openapi.json"), "utf8"));
if (existsSync(resolve(root, "docs/sbom.cdx.json"))) {
  const sbom = JSON.parse(readFileSync(resolve(root, "docs/sbom.cdx.json"), "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) failures.push("SBOM is not a CycloneDX component inventory");
}
const dockerfile = readFileSync(resolve(root, "docker/tool-runtime/Dockerfile"), "utf8");
if (!/^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/mi.test(dockerfile)) failures.push("tool runtime base image is not digest-pinned");
const browserDockerfile = readFileSync(resolve(root, "docker/browser-runtime/Dockerfile"), "utf8");
if (!/^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/mi.test(browserDockerfile)) failures.push("browser runtime base image is not digest-pinned");
const expectedIgnored = [
  ".env.local", "node_modules/example.js", "coverage/index.html", ".lite-harness/state.db",
  "sdks/python/.venv/python", "playwright-report/index.html", "runtime.sqlite-wal", "temp/output.tmp",
];
try {
  const ignored = new Set(execFileSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: root, input: `${expectedIgnored.join("\0")}\0`, encoding: "utf8",
  }).split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/")));
  for (const file of expectedIgnored) if (!ignored.has(file)) failures.push(`.gitignore does not cover ${file}`);
} catch {
  failures.push(".gitignore verification failed");
}
try {
  execFileSync("git", ["check-ignore", "--no-index", "--quiet", ".env.example"], { cwd: root });
  failures.push(".gitignore must keep .env.example trackable");
} catch (error) {
  if (error.status !== 1) failures.push(".env.example ignore exception verification failed");
}
const ciWorkflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
for (const command of [
  "pnpm verify", "pnpm audit --prod --audit-level high", "pnpm generate:sbom",
  "pnpm check:secrets", "pnpm check:provenance", "pnpm check:release", "pnpm check:truth-structure", "pnpm check:evidence",
  "pnpm check:requirements:verified", "pnpm check:defects:closed", "pnpm check:requirements", "pnpm check:defects",
]) {
  if (!ciWorkflow.includes(command)) failures.push(`CI is missing required branch command: ${command}`);
}
if (!ciWorkflow.includes("candidate-evidence-truth:") || !ciWorkflow.includes("actions/download-artifact@") ||
    !ciWorkflow.includes("pnpm assemble:ci-evidence -- --source .candidate-evidence --allow-incomplete") ||
    !ciWorkflow.includes("NEEDS_JSON: ${{ toJSON(needs) }}") || !ciWorkflow.includes("FANIN_CHECKS_JSON:") ||
    !ciWorkflow.includes("pnpm check:secrets -- --include evidence --evidence") ||
    !ciWorkflow.includes("pnpm aggregate:evidence") || !ciWorkflow.includes("lite-harness-candidate-evidence") ||
    !ciWorkflow.includes("steps.evidence_secret_scan.outcome == 'success'") ||
    !ciWorkflow.includes("steps.aggregate_secret_scan.outcome == 'success'")) {
  failures.push("CI lacks a fail-closed candidate evidence fan-in");
}
const imageWorkflow = readFileSync(resolve(root, ".github/workflows/images.yml"), "utf8");
for (const command of ["pnpm audit --prod --audit-level high", "pnpm generate:sbom", "pnpm release:check"]) {
  if (!imageWorkflow.includes(command)) failures.push(`release workflow is missing required gate: ${command}`);
}
if (!/publish:\s*[\s\S]*?needs:\s*\[[^\]]*release-gate[^\]]*candidate[^\]]*\]/.test(imageWorkflow)) {
  failures.push("container publishing must depend on the strict release gate and tested candidates");
}
if (/lite-harness-\$\{\{ matrix\.name \}\}:latest/.test(imageWorkflow)) failures.push("prerelease tags must not promote mutable latest images");
for (const workflowName of ["ci.yml", "images.yml"]) {
  const workflow = readFileSync(resolve(root, ".github/workflows", workflowName), "utf8");
  for (const match of workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)) {
    if (!/^[a-f0-9]{40}$/.test(match[1])) failures.push(`${workflowName} contains an unpinned action reference: ${match[0]}`);
  }
}
if (existsSync(resolve(root, "docs/performance-baseline.json"))) {
  const performance = JSON.parse(readFileSync(resolve(root, "docs/performance-baseline.json"), "utf8"));
  if (performance.provider !== "fake" || performance.terminalStatus !== "SUCCEEDED") failures.push("kernel performance baseline is missing a successful model-free run");
}
if (existsSync(resolve(root, "docs/pxpipe-evaluation.json"))) {
  const contextEvaluation = JSON.parse(readFileSync(resolve(root, "docs/pxpipe-evaluation.json"), "utf8"));
  if (!Array.isArray(contextEvaluation.evaluations) || !contextEvaluation.evaluations.every((item) => item.exactRecoveryVerified === true) ||
      contextEvaluation.policy !== "measurement-only-disabled-by-default") failures.push("pxpipe evaluation must verify exact recovery and remain disabled by default");
}
if (existsSync(resolve(root, "docs/pxpipe-paired-evaluation.json"))) {
  const paired = JSON.parse(readFileSync(resolve(root, "docs/pxpipe-paired-evaluation.json"), "utf8"));
  if (paired.evaluationType !== "paired-model-quality-cost" || paired.testId !== "BD-050-REGRESSION" ||
      paired.provider?.route !== "local-hermes-openai-compatible" || paired.provider?.model !== "gpt-5.6-luna" ||
      paired.provider?.standardApiPricing?.pricingSource !== "openai-standard-2026-07-09" ||
      paired.provider?.standardApiPricing?.inputUsdPerMillion !== 1 || paired.provider?.standardApiPricing?.outputUsdPerMillion !== 6 ||
      !Array.isArray(paired.evaluations) || paired.evaluations.length < 2 ||
      !paired.evaluations.every((item) => item.exactRecoveryVerified === true && item.text?.score !== undefined && item.optical?.score !== undefined) ||
      paired.aggregate?.promotionEligible !== false || paired.policy !== "measurement-only-disabled-by-default") {
    failures.push("paired pxpipe evidence is incomplete, unscored, or incorrectly promotes the preview feature");
  }
  if (!/^[a-f0-9]{40}$/.test(paired.sourceCommit ?? "")) failures.push("paired pxpipe evidence has no exact source commit");
  else {
    try { execFileSync("git", ["merge-base", "--is-ancestor", paired.sourceCommit, "HEAD"], { cwd: root }); }
    catch { failures.push("paired pxpipe evidence source commit is not an ancestor of HEAD"); }
  }
}
if (existsSync(resolve(root, "sdks/python/pyproject.toml"))) {
  const pythonManifest = readFileSync(resolve(root, "sdks/python/pyproject.toml"), "utf8");
  if (!/version\s*=\s*"[^"]*(?:a|alpha|dev|rc)[^"]*"/i.test(pythonManifest)) failures.push("Python SDK must remain a prerelease");
}
const architecture = readFileSync(resolve(root, "docs/ARCHITECTURE.md"), "utf8");
if (!architecture.includes("NOT YET A VERIFIED ALPHA")) failures.push("architecture documentation lacks an evidence-qualified alpha warning");

validateOpenApiSemantics();
validateArtifactInstallability();
validateAlphaBehavior();

for (const directory of [resolve(root, "apps"), resolve(root, "packages")]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = resolve(directory, entry.name, "package.json");
    if (!existsSync(packagePath)) continue;
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    if (manifest.private !== true) failures.push(`${manifest.name ?? packagePath} must remain private until naming is resolved`);
  }
}

try {
  execFileSync("git", ["merge-base", "--is-ancestor", "834810b3d6e367cbdf69b4c822d220f1a150b14c", "HEAD"], { cwd: root });
} catch {
  failures.push("Lite branch no longer descends from the pinned OpenClaw baseline");
}

function validateOpenApiSemantics() {
  try {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/generate-openapi.ts", "--check"], { cwd: root, stdio: "pipe" });
  } catch {
    failures.push("OpenAPI is stale relative to the authoritative contract schemas");
    return;
  }
  const document = JSON.parse(readFileSync(resolve(root, "docs/openapi.json"), "utf8"));
  if (!/^3\.1\./.test(document.openapi ?? "") || document["x-lite-generated-from-contracts"]?.version !== 2) {
    failures.push("OpenAPI lacks its versioned 3.1 contract-generation marker");
  }
  const schemaNames = Object.keys(document.components?.schemas ?? {});
  if (!schemaNames.length || JSON.stringify(document["x-lite-contract-schemas"] ?? []) !== JSON.stringify(schemaNames)) {
    failures.push("OpenAPI schema inventory is not the generated public contract inventory");
  }
  const generatedTypescript = readFileSync(resolve(root, "packages/sdk-typescript/src/generated-api.ts"), "utf8");
  const generatedPython = readFileSync(resolve(root, "sdks/python/src/lite_harness/generated_api.py"), "utf8");
  for (const schemaName of schemaNames) {
    if (!new RegExp(`^export type ${schemaName}\\s*=`, "m").test(generatedTypescript)) failures.push(`TypeScript SDK is missing generated model ${schemaName}`);
    if (!new RegExp(`(?:^class ${schemaName}\\(|^${schemaName}: TypeAlias)`, "m").test(generatedPython)) failures.push(`Python SDK is missing generated model ${schemaName}`);
  }
  const operationIds = new Set();
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!path.startsWith("/")) failures.push(`OpenAPI path is not absolute: ${path}`);
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (!operation || typeof operation !== "object" || !Object.keys(operation.responses ?? {}).length) {
        failures.push(`OpenAPI operation ${method.toUpperCase()} ${path} has no response contract`);
      }
      if (!operation.operationId) {
        failures.push(`OpenAPI operation ${method.toUpperCase()} ${path} has no operationId`);
      } else {
        if (operationIds.has(operation.operationId)) failures.push(`duplicate OpenAPI operationId ${operation.operationId}`);
        operationIds.add(operation.operationId);
        if (!generatedTypescript.includes(JSON.stringify(operation.operationId)) || !generatedPython.includes(JSON.stringify(operation.operationId))) {
          failures.push(`generated SDK operation inventory is missing ${operation.operationId}`);
        }
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        const media = response?.content?.["application/json"] ?? response?.content?.["text/event-stream"];
        if (/^2\d\d$/.test(status) && !media?.schema?.$ref) failures.push(`OpenAPI success ${method.toUpperCase()} ${path} ${status} has no typed schema`);
        if (/^[45]\d\d$/.test(status) && !media?.schema?.$ref) failures.push(`OpenAPI error ${method.toUpperCase()} ${path} ${status} has no typed schema`);
      }
      if (operation.requestBody && !operation.requestBody.content?.["application/json"]?.schema?.$ref) {
        failures.push(`OpenAPI request ${method.toUpperCase()} ${path} has no typed JSON schema`);
      }
    }
  }
  for (const reference of JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
    if (!document.components?.schemas?.[reference[1]]) failures.push(`OpenAPI has an unresolved schema reference: ${reference[1]}`);
  }
}

function validateArtifactInstallability() {
  try {
    execFileSync(process.execPath, ["scripts/check-built-artifacts.mjs", "--python-wheel"], { cwd: root, stdio: "pipe" });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(-2_000);
    failures.push(`packaged Node and Python artifacts are not installable through the real Gateway: ${detail}`);
  }
}

function validateAlphaBehavior() {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (!/-(?:alpha|beta|rc|dev)[.-]?\d*/i.test(manifest.version ?? "")) failures.push("root package must remain an explicit prerelease");
  if (manifest.private !== true) failures.push("root workspace must remain private during alpha");
  if (!imageWorkflow.includes("pnpm release:check")) failures.push("tag publication bypasses alpha release behavior checks");
  if (!imageWorkflow.includes("Promote only tested platform digests")) failures.push("alpha image promotion does not reuse tested candidates");
}

if (failures.length) {
  process.stderr.write(`Release checks failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  const assertions = {
    openApiGeneratedWithoutDrift: true,
    openApiReferencesResolve: true,
    nodePackagesInstallAndRunThroughGateway: true,
    pythonWheelInstallsAndRunsThroughGateway: true,
    prereleaseBehaviorEnforced: true,
    testedImageDigestPromotionEnforced: true,
  };
  writePolicyEvidence({
    root,
    output: "evidence/m11/release-validation.json",
    suite: "semantic-release-validation",
    command: "pnpm check:release",
    assertions,
    regressionIds: ["BD-057-REGRESSION"],
    sourcePath: "scripts/check-release.mjs",
    caseBindings: { "BD-057-REGRESSION": Object.keys(assertions) },
    claims: { knownOpenGap: "BD-061 requires complete authoritative OpenAPI and generated SDK models" },
  });
  process.stdout.write("Release structure checks passed.\n");
}
