import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const evidenceSchema = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "schemas", "release-evidence.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(evidenceSchema);

export const requiredExternalGateNames = Object.freeze([
  "linuxRootful",
  "linuxRootless",
  "linuxArm64",
  "macosIntelDockerDesktop",
  "macosAppleSiliconDockerDesktop",
  "windows11DockerDesktopWsl2",
  "openaiLive",
  "anthropicLive",
  "codexLive",
  "namingApproval",
  "signingAuthority",
  "registryPromotion",
]);

export const missingExternalGates = Object.freeze({
  linuxRootful: "missing",
  linuxRootless: "missing",
  linuxArm64: "missing",
  macosIntelDockerDesktop: "missing",
  macosAppleSiliconDockerDesktop: "missing",
  windows11DockerDesktopWsl2: "missing",
  openaiLive: "missing",
  anthropicLive: "missing",
  codexLive: "missing",
  namingApproval: "missing",
  signingAuthority: "missing",
  registryPromotion: "missing",
});

export function writeVitestEvidence({
  root,
  output,
  suite,
  command,
  report,
  requirementIds = [],
  regressionIds = [],
  claims = {},
  packages = [],
  images = [],
  externalGates = missingExternalGates,
  facts,
}) {
  const counts = {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
    todo: report.numTodoTests,
  };
  const proof = sanitizedVitestProof(root, report);
  const document = createEvidenceDocument({
    root,
    kind: "test-suite",
    suite,
    command,
    result: report.success === true ? "pass" : "fail",
    counts,
    durationMs: vitestDuration(report),
    cases: proofCases(proof),
    requirementIds,
    regressionIds,
    claims,
    packages,
    images,
    attachments: [embeddedAttachment("vitest-proof", "application/vnd.lite-harness.vitest-proof+json", proof)],
    externalGates,
    facts,
  });
  writeEvidenceFile(resolve(root, output), document);
  return document;
}

export function writePolicyEvidence({
  root,
  output,
  suite,
  command,
  assertions,
  requirementIds = [],
  regressionIds = [],
  claims = {},
  packages = [],
  images = [],
  externalGates = missingExternalGates,
  durationMs = 0,
  qualificationResult,
  sourcePath,
  caseBindings = {},
}) {
  const values = Object.values(assertions);
  if (!values.length || values.some((value) => typeof value !== "boolean")) {
    throw new Error("Policy evidence requires at least one boolean assertion");
  }
  const passed = values.filter(Boolean).length;
  const result = qualificationResult ?? (passed === values.length ? "pass" : "fail");
  if (!new Set(["pass", "fail", "blocked"]).has(result)) throw new Error(`Invalid policy qualification result: ${result}`);
  const cases = policyCases(assertions, caseBindings, sourcePath);
  const document = createEvidenceDocument({
    root,
    kind: "policy-check",
    suite,
    command,
    result,
    counts: { total: values.length, passed, failed: values.length - passed, skipped: 0, todo: 0 },
    durationMs,
    cases,
    requirementIds,
    regressionIds,
    claims: {
      ...claims,
      assertions,
      policyProof: { sourcePath, caseBindings },
    },
    packages,
    images,
    attachments: [],
    externalGates,
  });
  writeEvidenceFile(resolve(root, output), document);
  return document;
}

export function createEvidenceDocument({
  root,
  kind,
  suite,
  command,
  result,
  counts,
  durationMs,
  cases = [],
  requirementIds = [],
  regressionIds = [],
  claims = {},
  packages = [],
  images = [],
  attachments = [],
  externalGates = missingExternalGates,
  scope = packages.length || images.length ? "candidate-artifact" : "source-tree",
  facts,
}) {
  const captured = facts ?? captureFacts(root);
  return {
    schemaVersion: 2,
    kind,
    evidenceId: `${suite}-${captured.commit.slice(0, 12)}-${captured.platform.os}-${captured.platform.architecture}`,
    subject: {
      source: { commit: captured.commit, tree: captured.tree, dirty: captured.dirty },
      scope,
      packages: normalizedArtifacts(packages),
      images: normalizedArtifacts(images),
    },
    capture: {
      at: captured.at,
      platform: captured.platform,
      runtime: captured.runtime,
      ci: captured.ci,
    },
    test: { suite, command, result, counts, durationMs, cases },
    coverage: {
      requirementIds: sortedUnique(requirementIds),
      regressionIds: sortedUnique(regressionIds),
    },
    claims,
    attachments,
    externalGates,
  };
}

export function validateEvidenceDocument(document, { expectedCommit, expectedTree, requireClean = false } = {}) {
  const failures = [];
  if (!validateSchema(document)) {
    failures.push(...(validateSchema.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`));
    return failures;
  }
  failures.push(...evidenceContentSafetyFailures(document));
  const counts = document.test.counts;
  if (counts.total !== counts.passed + counts.failed + counts.skipped + counts.todo) {
    failures.push("test counts do not add up to total");
  }
  if (document.test.result === "pass") {
    if (counts.total < 1 || counts.passed !== counts.total || counts.failed !== 0 || counts.skipped !== 0 || counts.todo !== 0) {
      failures.push("pass evidence is not a nonempty zero-failure zero-skip result");
    }
    if (document.coverage.requirementIds.length + document.coverage.regressionIds.length === 0) {
      failures.push("pass evidence has no explicit requirement or regression coverage");
    }
    if (!document.test.cases.length || document.test.cases.some((item) => item.status !== "passed")) {
      failures.push("pass evidence has no complete set of passed execution cases");
    }
    if (document.capture.runtime.pnpm === "unavailable") failures.push("pass evidence did not capture the pnpm runtime version");
  }
  if (expectedCommit && document.subject.source.commit !== expectedCommit) {
    failures.push(`source commit ${document.subject.source.commit} does not match ${expectedCommit}`);
  }
  if (expectedTree && document.subject.source.tree !== expectedTree) {
    failures.push(`source tree ${document.subject.source.tree} does not match ${expectedTree}`);
  }
  if (requireClean && document.subject.source.dirty) failures.push("source worktree was dirty during evidence capture");
  for (const attachment of document.attachments) {
    if (sha256Json(attachment.content) !== attachment.sha256) failures.push(`attachment digest mismatch: ${attachment.name}`);
  }
  if (document.kind === "test-suite") validateVitestProof(document, failures);
  if (document.kind === "policy-check") validatePolicyProof(document, failures);
  return failures;
}

export function writeEvidenceFile(path, document) {
  const failures = validateEvidenceDocument(document);
  if (failures.length) throw new Error(`Invalid release evidence:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${path}.previous`;
  try {
    if (existsSync(backup)) {
      if (existsSync(path)) rmSync(backup, { force: true });
      else renameSync(backup, path);
    }
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(temporary, path);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      renameSync(path, backup);
      try {
        renameSync(temporary, path);
        rmSync(backup, { force: true });
      } catch (replacementError) {
        if (!existsSync(path) && existsSync(backup)) renameSync(backup, path);
        throw replacementError;
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function captureFacts(root) {
  const commit = git(root, "rev-parse", "HEAD");
  return {
    commit,
    tree: git(root, "rev-parse", `${commit}^{tree}`),
    dirty: git(root, "status", "--porcelain=v1").length > 0,
    at: new Date().toISOString(),
    platform: {
      os: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: Math.max(1, os.cpus().length),
    },
    runtime: {
      node: process.version,
      pnpm: pnpmVersion(root),
      docker: dockerFacts(root),
    },
    ci: {
      provider: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : null,
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      job: process.env.GITHUB_JOB ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
  };
}

export function embeddedAttachment(name, mediaType, content) {
  return { name, mediaType, sha256: sha256Json(content), content };
}

function normalizedArtifacts(artifacts) {
  return artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256.replace(/^sha256:/, "").toLowerCase() }));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function vitestDuration(report) {
  const starts = (report.testResults ?? []).map((result) => result.startTime).filter(Number.isFinite);
  const ends = (report.testResults ?? []).map((result) => result.endTime).filter(Number.isFinite);
  if (!starts.length || !ends.length) return 0;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

function sanitizedVitestProof(root, report) {
  return {
    format: "vitest-proof-v1",
    counts: {
      total: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests,
      todo: report.numTodoTests,
    },
    suites: (report.testResults ?? []).map((suite) => ({
      path: normalizedRepoPath(relative(root, suite.name)),
      status: normalizedCaseStatus(suite.status),
      durationMs: finiteDuration(suite.endTime - suite.startTime),
      cases: (suite.assertionResults ?? []).map((item) => ({
        name: sanitizeCaseName(item.fullName || item.title || "unnamed assertion"),
        status: normalizedCaseStatus(item.status),
        durationMs: finiteDuration(item.duration),
      })),
    })),
  };
}

function proofCases(proof) {
  return proof.suites.flatMap((suite) => suite.cases.map((item) => ({
    path: suite.path,
    name: item.name,
    status: item.status,
  })));
}

function sanitizeCaseName(value) {
  return sanitizeDiagnosticText(value, { maxBytes: 512 });
}

export function sanitizeDiagnosticText(value, { maxBytes = 4 * 1024 } = {}) {
  const limit = Number.isSafeInteger(maxBytes) ? Math.min(Math.max(maxBytes, 128), 64 * 1024) : 4 * 1024;
  const sanitized = String(value)
    .replace(/-----BEGIN (?:(?:RSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:(?:RSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|$)/g, "<redacted-private-key>")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@\s/:]*:[^@\s/]+@/g, "$1<redacted-credentials>@")
    .replace(/file:\/\/\/[^\s"'<>)]*/gi, "<redacted-path>")
    .replace(/(^|[^A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s"'<>)]*/gi, "$1<redacted-path>")
    .replace(/\\\\(?:[?.]\\)?[^\\/\s]+[\\/][^\s"'<>)]*/g, "<redacted-path>")
    .replace(/(^|[^A-Za-z0-9_/])\/(?!\/)[A-Za-z0-9._~-]+(?:[\\/][^\s"'<>)]*)?/g, "$1<redacted-path>")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "<redacted-secret>")
    .replace(/\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, "<redacted-secret>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi, "Bearer <redacted-secret>")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}\b/gi, "Basic <redacted-secret>")
    .replace(/(["']?authorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,}\r\n]*)/gi, "$1<redacted-secret>")
    .replace(/(["']?(?:set[_-]?)?cookie["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,}\r\n]*)/gi, "$1<redacted-secret>")
    .replace(/(["']?(?:api[_-]?key|token|secret|credential|password)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,\s}\r\n]+)/gi, "$1<redacted-secret>")
    .replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(sanitized, "utf8") <= limit) return sanitized;
  const suffix = "\n<diagnostic-truncated>";
  const budget = limit - Buffer.byteLength(suffix, "utf8");
  const prefix = [];
  let bytes = 0;
  for (const character of sanitized) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    prefix.push(character);
    bytes += size;
  }
  return `${prefix.join("")}${suffix}`;
}

function policyCases(assertions, caseBindings, sourcePath) {
  const entries = Object.entries(caseBindings);
  if (!entries.length) return [];
  const path = normalizedRepoPath(sourcePath);
  return entries.map(([id, assertionNames]) => {
    if (!Array.isArray(assertionNames) || !assertionNames.length) {
      throw new Error(`Policy case ${id} must bind at least one assertion`);
    }
    const values = assertionNames.map((name) => {
      if (!Object.hasOwn(assertions, name)) throw new Error(`Policy case ${id} names unknown assertion ${name}`);
      return assertions[name];
    });
    return { path, name: id, status: values.every(Boolean) ? "passed" : "failed" };
  });
}

function validateVitestProof(document, failures) {
  const proofs = document.attachments.filter((item) => item.name === "vitest-proof");
  if (proofs.length !== 1) {
    failures.push("test-suite evidence must contain exactly one sanitized vitest-proof attachment");
    return;
  }
  const proof = proofs[0].content;
  if (!proof || proof.format !== "vitest-proof-v1" || !Array.isArray(proof.suites)) {
    failures.push("vitest-proof attachment is malformed");
    return;
  }
  try {
    if (JSON.stringify(proof.counts) !== JSON.stringify(document.test.counts)) failures.push("vitest-proof counts do not match evidence counts");
    if (JSON.stringify(proofCases(proof)) !== JSON.stringify(document.test.cases)) failures.push("vitest-proof cases do not match evidence cases");
    if (document.test.cases.length !== document.test.counts.total) failures.push("vitest-proof case count does not match total tests");
  } catch {
    failures.push("vitest-proof attachment is malformed");
  }
}

function validatePolicyProof(document, failures) {
  const assertions = document.claims?.assertions;
  const proof = document.claims?.policyProof;
  if (!assertions || typeof assertions !== "object" || !proof || typeof proof !== "object") {
    failures.push("policy-check evidence must contain assertion and case-binding proof");
    return;
  }
  try {
    const values = Object.values(assertions);
    const counts = {
      total: values.length,
      passed: values.filter(Boolean).length,
      failed: values.filter((value) => !value).length,
      skipped: 0,
      todo: 0,
    };
    if (!values.length || values.some((value) => typeof value !== "boolean")) throw new Error("invalid assertions");
    if (JSON.stringify(counts) !== JSON.stringify(document.test.counts)) failures.push("policy proof counts do not match evidence counts");
    if (JSON.stringify(policyCases(assertions, proof.caseBindings, proof.sourcePath)) !== JSON.stringify(document.test.cases)) {
      failures.push("policy proof case bindings do not match evidence cases");
    }
  } catch {
    failures.push("policy-check assertion or case-binding proof is malformed");
  }
}

function normalizedRepoPath(path) {
  if (typeof path !== "string" || !path) throw new Error("Evidence execution path must be a nonempty repository-relative path");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Evidence execution path is outside the repository: ${path}`);
  }
  return normalized.replace(/^\.\//, "");
}

function normalizedCaseStatus(status) {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "todo") return "todo";
  if (status === "pending" || status === "skipped") return "skipped";
  return "blocked";
}

function finiteDuration(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function evidenceContentSafetyFailures(document) {
  const values = stringValues(document);
  const patterns = [
    ["unredacted stack trace", /(?:^|\n)\s*at\s+(?:async\s+)?(?:[^\n(]+\s+\()?[^)\n]+:\d+:\d+\)?/m],
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["GitHub token", /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/],
    ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
    ["npm token", /\bnpm_[A-Za-z0-9_-]{20,}\b/],
    ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
    ["Anthropic-style key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}\b/i],
  ];
  const failures = patterns
    .filter(([, pattern]) => values.some((value) => pattern.test(value)))
    .map(([label]) => `evidence contains possible ${label}`);
  if (values.some((value) => /(?:file:\/{3})?[A-Za-z]:[\\/]/i.test(value))) {
    failures.push("evidence contains possible drive-absolute filesystem path");
  }
  if (values.some((value) => /\\\\(?:[?.]\\)?[^\\/\s]+[\\/]/.test(value))) {
    failures.push("evidence contains possible UNC or device filesystem path");
  }
  if (values.some(containsUnixAbsolutePath)) failures.push("evidence contains possible Unix-absolute filesystem path");
  return [...new Set(failures)];
}

function stringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

function containsUnixAbsolutePath(value) {
  const withoutNetworkUrls = value.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "");
  return /(?:^|[^A-Za-z0-9_])\/(?!\/)[A-Za-z0-9._~-]+(?:[\\/][^\s"'<>]*)?/.test(withoutNetworkUrls);
}

function pnpmVersion(root) {
  const userAgent = process.env.npm_config_user_agent ?? "";
  const match = /(?:^|\s)pnpm\/([^\s]+)/.exec(userAgent);
  if (match) return match[1];
  const candidates = process.platform === "win32"
    ? [["cmd.exe", ["/d", "/s", "/c", "corepack pnpm --version"]], ["cmd.exe", ["/d", "/s", "/c", "pnpm --version"]]]
    : [["corepack", ["pnpm", "--version"]], ["pnpm", ["--version"]]];
  for (const [command, args] of candidates) {
    try {
      return execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    } catch {
      // Try the next platform-safe launcher.
    }
  }
  return "unavailable";
}

function dockerFacts(root) {
  try {
    const version = JSON.parse(execFileSync("docker", ["version", "--format", "{{json .}}"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    }));
    return {
      available: true,
      context: execFileSync("docker", ["context", "show"], { cwd: root, encoding: "utf8", timeout: 5_000, windowsHide: true }).trim(),
      clientVersion: version.Client?.Version ?? null,
      serverVersion: version.Server?.Version ?? null,
      serverOs: version.Server?.Os ?? null,
      serverArchitecture: version.Server?.Arch ?? null,
      platform: version.Server?.Platform?.Name ?? null,
      kernel: version.Server?.KernelVersion ?? null,
    };
  } catch {
    return {
      available: false,
      context: null,
      clientVersion: null,
      serverVersion: null,
      serverOs: null,
      serverArchitecture: null,
      platform: null,
      kernel: null,
    };
  }
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
