import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "UPSTREAM.md",
  "PROVENANCE.json", "THIRD_PARTY_NOTICES.md", "docs/ARCHITECTURE.md",
  "docs/API.md", "docs/BROWSER.md", "docs/INTEGRATIONS.md", "docs/THREAT_MODEL.md", "docs/RECOVERY.md",
  "docs/OPERATIONS.md", "docs/TESTING.md", "docs/CONTEXT_OPTIMIZATION.md", "docs/SUBAGENTS_AND_MEMORY.md",
  "docs/MIGRATION.md", "docs/IMPLEMENTATION_STATUS.md", "docs/SECURITY_REVIEW.md", "docs/openapi.json", "docs/sbom.cdx.json",
  "docs/performance-baseline.json", "docs/pxpipe-evaluation.json",
  ".github/workflows/ci.yml", ".github/workflows/security.yml", ".github/workflows/images.yml",
  "docker/tool-runtime/Dockerfile", "docker/browser-runtime/Dockerfile", "sdks/python/pyproject.toml",
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
if (existsSync(resolve(root, "docs/performance-baseline.json"))) {
  const performance = JSON.parse(readFileSync(resolve(root, "docs/performance-baseline.json"), "utf8"));
  if (performance.provider !== "fake" || performance.terminalStatus !== "SUCCEEDED") failures.push("kernel performance baseline is missing a successful model-free run");
}
if (existsSync(resolve(root, "docs/pxpipe-evaluation.json"))) {
  const contextEvaluation = JSON.parse(readFileSync(resolve(root, "docs/pxpipe-evaluation.json"), "utf8"));
  if (!Array.isArray(contextEvaluation.evaluations) || !contextEvaluation.evaluations.every((item) => item.exactRecoveryVerified === true) ||
      contextEvaluation.policy !== "measurement-only-disabled-by-default") failures.push("pxpipe evaluation must verify exact recovery and remain disabled by default");
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
