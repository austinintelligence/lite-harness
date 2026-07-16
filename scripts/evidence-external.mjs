import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  captureFacts,
  createEvidenceDocument,
  embeddedAttachment,
  missingExternalGates,
  sanitizeDiagnosticText,
  writeEvidenceFile,
} from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");

/**
 * External platform evidence is intentionally a CI-only producer. It is the
 * authority for one host lane at a time; it never marks another lane or an
 * owner-controlled approval gate as passed.
 */
export const externalPlatformGates = Object.freeze({
  linuxRootful: Object.freeze({ os: "linux", architecture: "x64", rootless: false, desktop: false, runnerLabels: ["self-hosted", "linux", "x64", "docker-rootful"] }),
  linuxRootless: Object.freeze({ os: "linux", architecture: "x64", rootless: true, desktop: false, runnerLabels: ["self-hosted", "linux", "x64", "docker-rootless"] }),
  linuxArm64: Object.freeze({ os: "linux", architecture: "arm64", rootless: false, desktop: false, runnerLabels: ["self-hosted", "linux", "arm64", "docker-rootful"] }),
  macosIntelDockerDesktop: Object.freeze({ os: "darwin", architecture: "x64", rootless: false, desktop: true, runnerLabels: ["self-hosted", "macos", "x64", "docker-desktop"] }),
  macosAppleSiliconDockerDesktop: Object.freeze({ os: "darwin", architecture: "arm64", rootless: false, desktop: true, runnerLabels: ["self-hosted", "macos", "arm64", "docker-desktop"] }),
  windows11DockerDesktopWsl2: Object.freeze({ os: "win32", architecture: "x64", rootless: false, desktop: true, runnerLabels: ["self-hosted", "windows", "x64", "docker-desktop-wsl2"] }),
});

export const externalPlatformGateNames = Object.freeze(Object.keys(externalPlatformGates));

export const externalPlatformEvidencePaths = Object.freeze({
  linuxRootful: "evidence/external/linux-rootful.json",
  linuxRootless: "evidence/external/linux-rootless.json",
  linuxArm64: "evidence/external/linux-arm64.json",
  macosIntelDockerDesktop: "evidence/external/macos-intel.json",
  macosAppleSiliconDockerDesktop: "evidence/external/macos-apple-silicon.json",
  windows11DockerDesktopWsl2: "evidence/external/windows-wsl2.json",
});

export function validateExternalPlatform(gate, facts, dockerInfo) {
  const spec = externalPlatformGates[gate];
  if (!spec) return [`unsupported external platform gate: ${gate}`];
  const failures = [];
  if (facts?.platform?.os !== spec.os) failures.push(`host OS must be ${spec.os}`);
  if (facts?.platform?.architecture !== spec.architecture) failures.push(`host architecture must be ${spec.architecture}`);
  if (!dockerInfo || typeof dockerInfo !== "object") {
    failures.push("Docker info is unavailable");
    return failures;
  }
  if (dockerInfo.OSType !== "linux") failures.push("Docker server must expose Linux containers");
  const securityOptions = Array.isArray(dockerInfo.SecurityOptions) ? dockerInfo.SecurityOptions.map(String) : [];
  const isRootless = securityOptions.some((item) => /rootless/i.test(item));
  if (spec.rootless && !isRootless) failures.push("Docker must be running in rootless mode");
  if (!spec.rootless && isRootless) failures.push("Docker rootless mode is not valid for this gate");
  if (spec.desktop) {
    const operatingSystem = [dockerInfo.OperatingSystem, dockerInfo.Name, dockerInfo.Platform].filter(Boolean).join(" ");
    if (!/docker desktop/i.test(operatingSystem)) failures.push("Docker Desktop must identify itself in Docker info");
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runExternalEvidence();
}

function runExternalEvidence() {
  const gate = option("--gate");
  const spec = externalPlatformGates[gate];
  if (!spec) {
    if (gate && Object.hasOwn(missingExternalGates, gate)) {
      throw new Error(`${gate} is an owner-controlled or provider-controlled gate; platform evidence cannot self-assert it`);
    }
    throw new Error(`--gate must be one of: ${externalPlatformGateNames.join(", ")}`);
  }
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("External platform evidence is CI-only; run the pinned external-platform-evidence workflow on its declared self-hosted lane");
  }

  const output = option("--evidence") ?? externalPlatformEvidencePaths[gate];
  const startedAt = Date.now();
  const initialFacts = captureFacts(root);
  const dockerInfo = readDockerInfo();
  const hostFailures = validateExternalPlatform(gate, initialFacts, dockerInfo);
  let imageBuild = { tool: null, browser: null, failures: [] };
  let runtimeEvidence;
  let runtimePassed = false;

  if (!hostFailures.length) {
    imageBuild = buildRuntimeImages();
    if (!imageBuild.failures.length) {
      runtimeEvidence = runRequiredRuntime(imageBuild.tool, imageBuild.tool, imageBuild.browser);
      runtimePassed = runtimeEvidence?.test?.result === "pass";
    }
  }

  const facts = captureFacts(root);
  const assertions = {
    hostIdentityMatchesDeclaredLane: hostFailures.length === 0,
    dockerInfoIsAvailableAndPolicyMatchesLane: hostFailures.length === 0,
    immutableRuntimeImagesBuilt: !imageBuild.failures.length && Boolean(imageBuild.tool && imageBuild.browser),
    requiredRealRuntimePassedWithZeroSkips: runtimePassed,
  };
  const result = Object.values(assertions).every(Boolean) ? "pass" : "fail";
  const caseName = `A01-EXTERNAL-PLATFORM-EVIDENCE ${gate}`;
  const caseStatus = result === "pass" ? "passed" : "failed";
  const externalGates = { ...missingExternalGates, [gate]: result === "pass" ? "pass" : "fail" };
  const caseBindings = { [caseName]: Object.keys(assertions) };
  const failures = [...hostFailures, ...imageBuild.failures];
  if (!runtimePassed) failures.push("required real runtime did not produce a zero-skip pass");
  const claims = {
    assertions,
    policyProof: { sourcePath: "scripts/evidence-external.mjs", caseBindings },
    lane: {
      gate,
      expected: spec,
      captured: {
        hostOs: facts.platform.os,
        hostArchitecture: facts.platform.architecture,
        dockerContext: facts.runtime.docker.context,
        dockerServerOs: dockerInfo?.OSType ?? null,
        dockerRootless: Array.isArray(dockerInfo?.SecurityOptions) && dockerInfo.SecurityOptions.some((item) => /rootless/i.test(String(item))),
      },
    },
    failures: failures.map((failure) => sanitizeDiagnosticText(failure, { maxBytes: 1_024 })),
    runtimeEvidence: runtimeEvidence ? {
      evidenceId: runtimeEvidence.evidenceId,
      sha256: sha256Json(runtimeEvidence),
    } : null,
  };
  const document = createEvidenceDocument({
    root,
    kind: "policy-check",
    scope: "external-platform",
    suite: `external-${gate}`,
    command: `pnpm evidence:external --gate ${gate}`,
    result,
    counts: { total: Object.keys(assertions).length, passed: Object.values(assertions).filter(Boolean).length, failed: Object.values(assertions).filter((value) => !value).length, skipped: 0, todo: 0 },
    durationMs: Date.now() - startedAt,
    cases: [{ path: "scripts/evidence-external.mjs", name: caseName, status: caseStatus }],
    requirementIds: ["A01"],
    regressionIds: ["BD-058-REGRESSION"],
    claims,
    attachments: runtimeEvidence ? [embeddedAttachment("required-real-runtime", "application/vnd.lite-harness.evidence+json", runtimeEvidence)] : [],
    externalGates,
    facts,
  });
  writeEvidenceFile(resolve(root, output), document);
  process.stdout.write(`External ${gate} evidence written (${result}).\n`);
  if (result !== "pass") process.exitCode = 1;
}

function readDockerInfo() {
  const result = spawnSync("docker", ["info", "--format", "{{json .}}"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function buildRuntimeImages() {
  const tool = buildImage("docker/tool-runtime");
  const browser = buildImage("docker/browser-runtime");
  return { tool: tool.digest, browser: browser.digest, failures: [...tool.failures, ...browser.failures] };
}

function buildImage(context) {
  const result = spawnSync("docker", ["build", "-q", context], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15 * 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const digest = /sha256:[a-f0-9]{64}/i.exec(result.stdout ?? "")?.[0]?.toLowerCase() ?? null;
  const failures = [];
  if (result.status !== 0) failures.push(`${context} image build failed: ${sanitizeDiagnosticText(result.stderr ?? "unknown Docker build failure")}`);
  if (!digest) failures.push(`${context} image build did not return an immutable sha256 digest`);
  return { digest, failures };
}

function runRequiredRuntime(toolImage, mcpImage, browserImage) {
  const temporary = mkdtempSync(resolve(tmpdir(), "lite-external-runtime-"));
  const evidencePath = resolve(temporary, "required-real-runtime.json");
  try {
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts", "check-real-runtime.mjs"), "--evidence", evidencePath,
    ], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        LITE_HARNESS_ALLOW_DOCKER_RESTART: "1",
        LITE_HARNESS_TEST_DOCKER_IMAGE: toolImage,
        LITE_HARNESS_TEST_MCP_IMAGE: mcpImage,
        LITE_HARNESS_TEST_BROWSER_IMAGE: browserImage,
      },
    });
    if (!existsSync(evidencePath)) return undefined;
    const document = JSON.parse(readFileSync(evidencePath, "utf8"));
    if (result.status !== 0) return document;
    return document;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
