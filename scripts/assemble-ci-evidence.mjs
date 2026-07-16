import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const candidateEvidenceCatalog = Object.freeze([
  entry("m1-packaged-artifacts/packaged-artifacts.json", "evidence/m1/packaged-artifacts.json", "packaged-python-parity", "pnpm check:artifacts --python-wheel", "policy-check", "m1-packaged-artifacts"),
  entry("m10-context-optimization/context-optimization.json", "evidence/m10/context-optimization.json", "context-optimization-evidence", "pnpm test:context", "test-suite", "m10-context-optimization"),
  entry("m10-paired-context/paired-context-evaluation.json", "evidence/m10/paired-context-evaluation.json", "paired-context-evidence", "pnpm check:pxpipe-evidence", "policy-check", "m10-paired-context-evaluation"),
  entry("lite-harness-readiness-evidence/evidence/m11/doctor.json", "evidence/m11/doctor.json", "repository-readiness", "pnpm check:doctor", "policy-check", "production-doctor"),
  entry("m11-observability/observability.json", "evidence/m11/observability.json", "observability-evidence", "pnpm check:observability", "test-suite", "m11-observability"),
  entry("m11-status-truth/status-truth.json", "evidence/m11/status-truth.json", "status-truth-evidence", "pnpm check:status-truth", "test-suite", "m11-status-truth"),
  entry("m11-readiness/readiness.json", "evidence/m11/readiness.json", "readiness-evidence", "pnpm test:readiness", "test-suite", "m11-production-readiness"),
  entry("lite-harness-readiness-evidence/evidence/m11/release-validation.json", "evidence/m11/release-validation.json", "repository-readiness", "pnpm check:release", "policy-check", "semantic-release-validation"),
  entry("m2-backpressure/backpressure.json", "evidence/m2/backpressure.json", "backpressure-evidence", "pnpm test:backpressure", "test-suite", "m2-backpressure"),
  entry("m2-migrations/migrations.json", "evidence/m2/migrations.json", "migration-evidence", "pnpm test:migrations", "test-suite", "m2-migrations"),
  entry("m2-packaged-auth/packaged-auth.json", "evidence/m2/packaged-auth.json", "packaged-python-parity", "pnpm check:artifacts --python-wheel", "policy-check", "m2-packaged-auth"),
  entry("m2-reconnect-replay/reconnect-replay.json", "evidence/m2/reconnect-replay.json", "replay-evidence", "pnpm test:replay", "test-suite", "m2-reconnect-replay"),
  entry("m3-docker-policy/docker-policy.json", "evidence/m3/docker-policy.json", "docker-policy-evidence", "pnpm test:docker", "test-suite", "m3-docker-policy"),
  entry("lite-harness-readiness-evidence/evidence/m3/image-promotion.json", "evidence/m3/image-promotion.json", "repository-readiness", "pnpm check:images", "policy-check", "candidate-image-promotion"),
  entry("required-real-runtime/required-real-runtime.json", "evidence/m3/required-real-runtime.json", "required-real-runtime", "pnpm test:real-runtime", "test-suite", "required-real-runtime"),
  entry("m4-automatic-workspace-lifecycle/automatic-workspace-lifecycle.json", "evidence/m4/automatic-workspace-lifecycle.json", "workspace-lifecycle-evidence", "pnpm test:workspace-lifecycle", "test-suite", "m4-workspace-lifecycle"),
  entry("m4-workspace-recovery/workspace-recovery.json", "evidence/m4/workspace-recovery.json", "recovery-evidence", "pnpm test:recovery", "test-suite", "m4-workspace-recovery"),
  entry("m5-provider-conformance/provider-conformance.json", "evidence/m5/provider-conformance.json", "provider-evidence", "pnpm test:providers", "test-suite", "m5-provider-conformance"),
  entry("m6-approval-security/approval-security.json", "evidence/m6/approval-security.json", "approval-evidence", "pnpm test:approvals", "test-suite", "m6-approval-security"),
  entry("m6-plugin-security/plugin-security.json", "evidence/m6/plugin-security.json", "plugin-evidence", "pnpm test:plugins", "test-suite", "m6-plugin-security"),
  entry("m7-browser-core/browser-core.json", "evidence/m7/browser-core.json", "browser-evidence", "pnpm test:browser", "test-suite", "m7-browser-core"),
  entry("m8-integration-authenticity/integration-authenticity.json", "evidence/m8/integration-authenticity.json", "integration-evidence", "pnpm test:integrations", "test-suite", "m8-integration-authenticity"),
  entry("m9-optional-composition/optional-composition.json", "evidence/m9/optional-composition.json", "optional-system-evidence", "pnpm test:optional-systems", "test-suite", "m9-optional-composition"),
  entry("m9-run-snapshot/run-snapshot.json", "evidence/m9/run-snapshot.json", "run-snapshot-evidence", "pnpm test:run-snapshot", "test-suite", "m9-run-snapshot"),
]);

export const requiredExternalGateAuthorities = Object.freeze({
  linuxRootful: gate("linuxRootful", "evidence/external/linux-rootful.json", "rootless-product-evidence", "linux", "x64"),
  linuxRootless: gate("linuxRootless", "evidence/external/linux-rootless.json", "rootless-product-evidence", "linux", "x64"),
  linuxArm64: gate("linuxArm64", "evidence/external/linux-arm64.json", "rootless-product-evidence", "linux", "arm64"),
  macosIntelDockerDesktop: gate("macosIntelDockerDesktop", "evidence/external/macos-intel.json", "rootless-product-evidence", "darwin", "x64"),
  macosAppleSiliconDockerDesktop: gate("macosAppleSiliconDockerDesktop", "evidence/external/macos-apple-silicon.json", "rootless-product-evidence", "darwin", "arm64"),
  windows11DockerDesktopWsl2: gate("windows11DockerDesktopWsl2", "evidence/external/windows-wsl2.json", "rootless-product-evidence", "win32", "x64"),
  openaiLive: gate("openaiLive", "evidence/external/openai-live.json", "external-openai-live", null, null),
  anthropicLive: gate("anthropicLive", "evidence/external/anthropic-live.json", "external-anthropic-live", null, null),
  codexLive: gate("codexLive", "evidence/external/codex-live.json", "external-codex-live", null, null),
  namingApproval: gate("namingApproval", "evidence/external/naming-approval.json", "external-naming-approval", null, null),
  signingAuthority: gate("signingAuthority", "evidence/external/signing-authority.json", "external-signing-authority", null, null),
  registryPromotion: gate("registryPromotion", "evidence/external/registry-promotion.json", "external-registry-promotion", null, null),
});

export const candidateEvidenceLayout = Object.freeze(candidateEvidenceCatalog.map(({ source, target }) => Object.freeze([source, target])));
export const externalEvidenceLayout = Object.freeze(Object.entries(requiredExternalGateAuthorities)
  .map(([name, authority]) => Object.freeze([`external-${name}/${authority.path}`, authority.path])));

export function candidateEvidenceProducer(path) {
  return candidateEvidenceCatalog.find(({ target }) => target === path) ?? null;
}

export function candidateEvidenceCatalogFailures(path, document, { catalog = candidateEvidenceCatalog, expectedCi } = {}) {
  const registered = catalog.find(({ target }) => target === path);
  if (!registered) return [`candidate evidence path is not registered: ${path}`];
  const failures = [];
  if (document.kind !== registered.kind) failures.push(`kind must be ${registered.kind}`);
  if (document.test?.suite !== registered.suite) failures.push(`suite must be ${registered.suite}`);
  if (document.test?.command !== registered.producer) failures.push(`command must be ${registered.producer}`);
  if (document.capture?.ci?.provider !== "github-actions") failures.push("capture provider must be github-actions");
  if (document.capture?.ci?.job !== registered.ciJob) failures.push(`capture job must be ${registered.ciJob}`);
  for (const key of ["workflow", "runId", "runAttempt"]) {
    if (!document.capture?.ci?.[key]) failures.push(`capture ${key} is required`);
    if (expectedCi?.[key] && document.capture?.ci?.[key] !== expectedCi[key]) failures.push(`capture ${key} does not match the candidate run`);
  }
  return failures;
}

export function assembleCandidateEvidence(sourceRoot, targetRoot, { allowIncomplete = false, includeExternal = false } = {}) {
  const layouts = includeExternal ? [...candidateEvidenceLayout, ...externalEvidenceLayout] : candidateEvidenceLayout;
  const missing = layouts
    .filter(([source]) => !existsSync(resolve(sourceRoot, source)))
    .map(([source]) => source);
  if (missing.length && !allowIncomplete) {
    throw new Error(`Missing candidate evidence artifacts:\n${missing.map((path) => `- ${path}`).join("\n")}`);
  }

  for (const [source, target] of layouts) {
    if (!existsSync(resolve(sourceRoot, source))) continue;
    const sourcePath = resolve(sourceRoot, source);
    const targetPath = resolve(targetRoot, target);
    if (!allowIncomplete) JSON.parse(readFileSync(sourcePath, "utf8"));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
  return layouts.filter(([source]) => existsSync(resolve(sourceRoot, source))).map(([, target]) => target);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const sourceRoot = option("--source") ?? ".candidate-evidence";
  const targetRoot = option("--target") ?? ".";
  const copied = assembleCandidateEvidence(resolve(sourceRoot), resolve(targetRoot), {
    allowIncomplete: process.argv.includes("--allow-incomplete"),
    includeExternal: process.argv.includes("--include-external"),
  });
  process.stdout.write(`Reconstructed ${copied.length} candidate evidence paths under ${relative(process.cwd(), resolve(targetRoot)) || "."}.\n`);
}

function entry(source, target, ciJob, producer, kind, suite) {
  return Object.freeze({ source, target, ciJob, producer, kind, suite });
}

function gate(name, path, ciJob, os, architecture) {
  return Object.freeze({
    path,
    ciJob,
    os,
    architecture,
    kind: "policy-check",
    scope: "external-platform",
    suite: `external-${name}`,
    producer: `pnpm evidence:external --gate ${name}`,
  });
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}
