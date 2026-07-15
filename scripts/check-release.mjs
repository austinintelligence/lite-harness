import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "UPSTREAM.md",
  "PROVENANCE.json", "THIRD_PARTY_NOTICES.md", "docs/ARCHITECTURE.md",
  "docs/API.md", "docs/BROWSER.md", "docs/INTEGRATIONS.md", "docs/THREAT_MODEL.md", "docs/RECOVERY.md",
  "docs/OPERATIONS.md", "docs/TESTING.md", "docs/CONTEXT_OPTIMIZATION.md", "docs/SUBAGENTS_AND_MEMORY.md",
  "docs/MIGRATION.md", "docs/IMPLEMENTATION_STATUS.md", "docs/openapi.json", "docs/sbom.cdx.json",
  "docs/adr/README.md", "docs/adr/RESEARCH.md", "docs/adr/0001-node-typescript-stack.md",
  "docs/adr/0032-behavior-defined-compatibility.md", "docs/adr/0052-alpha-scope-and-preview-boundaries.md",
  "docs/requirements/alpha-ledger.yaml", "docs/requirements/defect-ledger.yaml",
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
if (!/^FROM\s+\S+@sha256:[a-f0-9]{64}$/m.test(dockerfile)) failures.push("tool runtime base image is not digest-pinned");
const browserDockerfile = readFileSync(resolve(root, "docker/browser-runtime/Dockerfile"), "utf8");
if (!/^FROM\s+\S+@sha256:[a-f0-9]{64}$/m.test(browserDockerfile)) failures.push("browser runtime base image is not digest-pinned");
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
  "pnpm check:secrets", "pnpm check:provenance", "pnpm check:release", "pnpm check:truth-structure",
]) {
  if (!ciWorkflow.includes(command)) failures.push(`CI is missing required branch command: ${command}`);
}
const imageWorkflow = readFileSync(resolve(root, ".github/workflows/images.yml"), "utf8");
for (const command of ["pnpm audit --prod --audit-level high", "pnpm generate:sbom", "pnpm release:check"]) {
  if (!imageWorkflow.includes(command)) failures.push(`release workflow is missing required gate: ${command}`);
}
if (!/publish:\s*[\s\S]*?needs:\s*release-gate/.test(imageWorkflow)) failures.push("container publishing must depend on the strict release gate");
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

if (failures.length) {
  process.stderr.write(`Release checks failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Release structure checks passed.\n");
}
