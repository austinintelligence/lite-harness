import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github", "workflows", "images.yml");
const workflow = readFileSync(workflowPath, "utf8");
const failures = [];
const required = [
  "id: build",
  "load: true",
  "docker run --rm ${{ steps.build.outputs.digest }}",
  "docker tag \"${{ steps.build.outputs.digest }}\" \"$candidate_ref\"",
  "docker push \"$candidate_ref\"",
  "needs: [release-gate, candidate]",
  "docker buildx imagetools create",
  'test "${#digests[@]}" -eq 2',
];
for (const token of required) if (!workflow.includes(token)) failures.push(`image workflow is missing: ${token}`);
for (const [name, expected] of [["tool-runtime", 2], ["browser-runtime", 2]]) {
  const count = workflow.split(`- name: ${name}`).length - 1;
  if (count !== expected) failures.push(`${name} must have exactly amd64 and arm64 candidate builds`);
}
for (const architecture of ["amd64", "arm64"]) {
  if (!workflow.includes(`arch: ${architecture}`)) failures.push(`image workflow is missing ${architecture}`);
}
if (/lite-harness-.*:latest/.test(workflow)) failures.push("prerelease workflow must not publish mutable latest tags");
for (const match of workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)) {
  if (!/^[a-f0-9]{40}$/.test(match[1])) failures.push(`image workflow has an unpinned action: ${match[0]}`);
}

if (failures.length) {
  process.stderr.write(`Image workflow checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  const evidenceIndex = process.argv.indexOf("--evidence");
  const output = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
  if (evidenceIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--evidence requires an output path");
  if (output) {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const path = resolve(root, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      commit,
      capturedAt: new Date().toISOString(),
      suite: "candidate-image-promotion",
      result: "pass",
      skips: 0,
      platforms: ["linux/amd64", "linux/arm64"],
      images: ["tool-runtime", "browser-runtime"],
      testIds: ["BD-056-REGRESSION"],
    }, null, 2)}\n`);
  }
  process.stdout.write("Candidate image promotion checks passed.\n");
}
