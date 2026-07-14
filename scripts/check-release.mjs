import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "UPSTREAM.md",
  "PROVENANCE.json", "THIRD_PARTY_NOTICES.md", "docs/ARCHITECTURE.md",
  "docs/API.md", "docs/THREAT_MODEL.md", "docs/RECOVERY.md", "docs/openapi.json",
  ".github/workflows/ci.yml", "docker/tool-runtime/Dockerfile",
];
const failures = required.filter((file) => !existsSync(resolve(root, file))).map((file) => `missing ${file}`);

JSON.parse(readFileSync(resolve(root, "docs/openapi.json"), "utf8"));
const dockerfile = readFileSync(resolve(root, "docker/tool-runtime/Dockerfile"), "utf8");
if (!/^FROM\s+\S+@sha256:[a-f0-9]{64}$/m.test(dockerfile)) failures.push("tool runtime base image is not digest-pinned");

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
