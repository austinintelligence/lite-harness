import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const candidateEvidenceLayout = Object.freeze([
  ["m1-packaged-artifacts/packaged-artifacts.json", "evidence/m1/packaged-artifacts.json"],
  ["m10-context-optimization/context-optimization.json", "evidence/m10/context-optimization.json"],
  ["lite-harness-readiness-evidence/evidence/m11/doctor.json", "evidence/m11/doctor.json"],
  ["m11-readiness/readiness.json", "evidence/m11/readiness.json"],
  ["lite-harness-readiness-evidence/evidence/m11/release-validation.json", "evidence/m11/release-validation.json"],
  ["m2-backpressure/backpressure.json", "evidence/m2/backpressure.json"],
  ["m2-migrations/migrations.json", "evidence/m2/migrations.json"],
  ["m2-packaged-auth/packaged-auth.json", "evidence/m2/packaged-auth.json"],
  ["m2-reconnect-replay/reconnect-replay.json", "evidence/m2/reconnect-replay.json"],
  ["m3-docker-policy/docker-policy.json", "evidence/m3/docker-policy.json"],
  ["lite-harness-readiness-evidence/evidence/m3/image-promotion.json", "evidence/m3/image-promotion.json"],
  ["required-real-runtime/required-real-runtime.json", "evidence/m3/required-real-runtime.json"],
  ["m4-automatic-workspace-lifecycle/automatic-workspace-lifecycle.json", "evidence/m4/automatic-workspace-lifecycle.json"],
  ["m4-workspace-recovery/workspace-recovery.json", "evidence/m4/workspace-recovery.json"],
  ["m5-provider-conformance/provider-conformance.json", "evidence/m5/provider-conformance.json"],
  ["m6-approval-security/approval-security.json", "evidence/m6/approval-security.json"],
  ["m6-plugin-security/plugin-security.json", "evidence/m6/plugin-security.json"],
  ["m7-browser-core/browser-core.json", "evidence/m7/browser-core.json"],
  ["m8-integration-authenticity/integration-authenticity.json", "evidence/m8/integration-authenticity.json"],
  ["m9-optional-composition/optional-composition.json", "evidence/m9/optional-composition.json"],
  ["m9-run-snapshot/run-snapshot.json", "evidence/m9/run-snapshot.json"],
]);

export function assembleCandidateEvidence(sourceRoot, targetRoot) {
  const missing = candidateEvidenceLayout
    .filter(([source]) => !existsSync(resolve(sourceRoot, source)))
    .map(([source]) => source);
  if (missing.length) {
    throw new Error(`Missing candidate evidence artifacts:\n${missing.map((path) => `- ${path}`).join("\n")}`);
  }

  for (const [source, target] of candidateEvidenceLayout) {
    const sourcePath = resolve(sourceRoot, source);
    const targetPath = resolve(targetRoot, target);
    JSON.parse(readFileSync(sourcePath, "utf8"));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
  return candidateEvidenceLayout.map(([, target]) => target);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const sourceRoot = option("--source") ?? ".candidate-evidence";
  const targetRoot = option("--target") ?? ".";
  const copied = assembleCandidateEvidence(resolve(sourceRoot), resolve(targetRoot));
  process.stdout.write(`Reconstructed ${copied.length} candidate evidence paths under ${relative(process.cwd(), resolve(targetRoot)) || "."}.\n`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}
