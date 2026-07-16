import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writePolicyEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github", "workflows", "images.yml");
const workflow = readFileSync(workflowPath, "utf8");
const ciWorkflow = readFileSync(resolve(root, ".github", "workflows", "ci.yml"), "utf8");
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
if (!/docker\/setup-buildx-action@[a-f0-9]{40}/.test(ciWorkflow) ||
    !/docker\/build-push-action@[a-f0-9]{40}[\s\S]{0,1000}?cache-from: type=gha[\s\S]{0,500}?cache-to: type=gha,mode=max/.test(ciWorkflow)) {
  failures.push("CI image builds do not delegate image and build-layer caching to pinned Docker/BuildKit actions");
}
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
    const assertions = {
      candidateBuildsAreLoadedAndExecuted: true,
      promotionReusesTestedDigests: true,
      bothRuntimeImagesCoverAmd64AndArm64: true,
      actionsAreCommitPinned: true,
      prereleaseNeverPublishesLatest: true,
      dockerBuildKitOwnsImageAndLayerCaching: true,
    };
    writePolicyEvidence({
      root,
      output,
      suite: "candidate-image-promotion",
      command: "pnpm check:images",
      assertions,
      requirementIds: ["D19"],
      regressionIds: ["BD-056-REGRESSION"],
      sourcePath: "scripts/check-image-workflow.mjs",
      caseBindings: {
        "BD-056-REGRESSION": Object.keys(assertions),
        D19: ["dockerBuildKitOwnsImageAndLayerCaching"],
      },
      claims: {
        advertisedPlatforms: ["linux/amd64", "linux/arm64"],
        imageNames: ["tool-runtime", "browser-runtime"],
        scope: "workflow-policy-only",
      },
    });
  }
  process.stdout.write("Candidate image promotion checks passed.\n");
}
