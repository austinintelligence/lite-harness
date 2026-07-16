import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCandidateEvidence, candidateEvidenceLayout, candidateEvidenceProducer } from "../scripts/assemble-ci-evidence.mjs";
import { createEvidenceDocument, embeddedAttachment, sanitizeDiagnosticText, validateEvidenceDocument, writeVitestEvidence } from "../scripts/evidence-lib.mjs";
import { defectClosureFailures, evaluateReleaseTruth, requirementVerificationFailures } from "../scripts/release-truth-lib.mjs";

const roots: string[] = [];
const candidateCommit = "a".repeat(40);
const candidateTree = "b".repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release truth", () => {
  it("A09-RESTART-GUARD fails the real-runtime wrapper closed without explicit Docker restart opt-in", () => {
    const env = { ...process.env };
    delete env.LITE_HARNESS_ALLOW_DOCKER_RESTART;
    const result = spawnSync(process.execPath, ["scripts/check-real-runtime.mjs"], {
      cwd: process.cwd(), env, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("LITE_HARNESS_ALLOW_DOCKER_RESTART=1");
  });

  it("requires current zero-skip evidence to name the exact requirement", () => {
    const root = fixtureRoot();
    const evidencePath = "evidence/m1/packaged-artifacts.json";
    writeFileSync(join(root, "implementation.ts"), "export {};\n");
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    writeJson(join(root, evidencePath), passEvidence({
      requirementIds: ["A02"],
      command: "pnpm check:artifacts --python-wheel",
      job: "packaged-python-parity",
      cases: [{ path: "regression.test.ts", name: "A02-REGRESSION", status: "passed" }],
    }));
    const row = {
      id: "A02", status: "verified", implementationPaths: ["implementation.ts"],
      testIds: ["A02-REGRESSION"], ciJob: "packaged-python-parity",
      evidenceArtifacts: [{ path: evidencePath, producer: "pnpm check:artifacts --python-wheel" }], blockers: [],
    };
    expect(requirementVerificationFailures(row, { root, head: candidateCommit, tree: candidateTree })).toEqual([]);
    const wrongProducer = structuredClone(row);
    wrongProducer.evidenceArtifacts[0]!.producer = "pnpm test:different";
    expect(requirementVerificationFailures(wrongProducer, { root, head: candidateCommit, tree: candidateTree }))
      .toContain(`evidence producer command does not match pnpm test:different: ${evidencePath}`);

    writeJson(join(root, evidencePath), passEvidence({
      requirementIds: ["D01"],
      command: "pnpm check:artifacts --python-wheel",
      job: "packaged-python-parity",
      cases: [{ path: "regression.test.ts", name: "A02-REGRESSION", status: "passed" }],
    }));
    expect(requirementVerificationFailures(row, { root, head: candidateCommit, tree: candidateTree }))
      .toContain(`evidence does not name requirement A02: ${evidencePath}`);
  });

  it("refuses a closed defect whose regression evidence targets another commit", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    const evidencePath = "evidence/m11/release-validation.json";
    writeJson(join(root, evidencePath), passEvidence({
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      regressionIds: ["BD-063-REGRESSION"],
      command: "pnpm check:release",
      job: "repository-readiness",
      cases: [{ path: "regression.test.ts", name: "BD-063-REGRESSION", status: "passed" }],
    }));
    const defect = {
      id: "BD-063", status: "closed", blockers: [],
      regression: {
        testId: "BD-063-REGRESSION", path: "regression.test.ts", result: "pass",
        evidenceArtifact: { path: evidencePath },
      },
    };
    expect(defectClosureFailures(defect, { root, head: candidateCommit, tree: candidateTree }))
      .toContain("closed without current zero-skip evidence");
  });

  it("refuses locally forged defect evidence even when commit, coverage, and test path match", () => {
    const root = fixtureRoot();
    const evidencePath = "evidence/m11/release-validation.json";
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    writeJson(join(root, evidencePath), passEvidence({
      regressionIds: ["BD-057-REGRESSION"],
      command: "pnpm check:release",
      provider: null,
      job: null,
      cases: [{ path: "regression.test.ts", name: "BD-057-REGRESSION", status: "passed" }],
    }));
    const defect = {
      id: "BD-057", status: "closed", blockers: [],
      regression: {
        testId: "BD-057-REGRESSION", path: "regression.test.ts", result: "pass",
        evidenceArtifact: { path: evidencePath },
      },
    };
    expect(defectClosureFailures(defect, { root, head: candidateCommit, tree: candidateTree }))
      .toContain("regression evidence was not captured by required CI job repository-readiness");
  });

  it("keeps stale verified rows and unproven closures in every truth summary", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "implementation.ts"), "export {};\n");
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    const evidencePath = "evidence/m1/packaged-artifacts.json";
    writeJson(join(root, evidencePath), passEvidence({
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      requirementIds: ["A02"],
      regressionIds: ["BD-063-REGRESSION"],
      command: "pnpm check:artifacts --python-wheel",
      job: "packaged-python-parity",
      cases: [
        { path: "regression.test.ts", name: "A02-REGRESSION", status: "passed" },
        { path: "regression.test.ts", name: "BD-063-REGRESSION", status: "passed" },
      ],
    }));
    const requirement = {
      id: "A02", status: "verified", implementationPaths: ["implementation.ts"],
      testIds: ["A02-REGRESSION"], ciJob: "packaged-python-parity",
      evidenceArtifacts: [{ path: evidencePath, producer: "pnpm check:artifacts --python-wheel" }], blockers: [],
    };
    const defect = {
      id: "BD-063", status: "closed", blockers: [],
      regression: {
        testId: "BD-063-REGRESSION", path: "regression.test.ts", result: "pass",
        evidenceArtifact: { path: evidencePath },
      },
    };
    const summary = evaluateReleaseTruth(
      { requirements: [requirement], defects: [defect] },
      { root, head: candidateCommit, tree: candidateTree },
    );
    expect(summary.requirementEvaluations[0]?.verified).toBe(false);
    expect(summary.defectEvaluations[0]?.closed).toBe(false);
  });

  it("BD-063-REGRESSION labels architecture and blocker documents as unverified", () => {
    expect(readFileSync(join(process.cwd(), "docs", "ARCHITECTURE.md"), "utf8"))
      .toContain("NOT YET A VERIFIED ALPHA");
    expect(readFileSync(join(process.cwd(), "BLOCKERS.md"), "utf8"))
      .toContain("NOT YET A VERIFIED ALPHA");
  });

  it("rejects dirty, empty, skipped, and tampered pass evidence", () => {
    const valid = passEvidence({
      requirementIds: ["A02"],
      attachments: [embeddedAttachment("report", "application/json", { passed: true })],
    });
    expect(validateEvidenceDocument(valid, {
      expectedCommit: candidateCommit,
      expectedTree: candidateTree,
      requireClean: true,
    })).toEqual([]);

    const dirty = structuredClone(valid);
    dirty.subject.source.dirty = true;
    expect(validateEvidenceDocument(dirty, { requireClean: true })).toContain("source worktree was dirty during evidence capture");

    const empty = structuredClone(valid);
    empty.test.counts = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
    expect(validateEvidenceDocument(empty).some((failure) => failure.includes("must be >= 1"))).toBe(true);

    const skipped = structuredClone(valid);
    skipped.test.counts = { total: 2, passed: 1, failed: 0, skipped: 1, todo: 0 };
    expect(validateEvidenceDocument(skipped).some((failure) => failure.includes("must be equal to constant"))).toBe(true);

    const tampered = structuredClone(valid);
    tampered.attachments[0]!.content = { passed: false };
    expect(validateEvidenceDocument(tampered)).toContain("attachment digest mismatch: report");

    const unsafe = structuredClone(valid);
    unsafe.claims.privatePath = "D:\\Downloads\\private-workspace\\trace.txt";
    expect(validateEvidenceDocument(unsafe)).toContain("evidence contains possible drive-absolute filesystem path");
    for (const [privatePath, expected] of [
      ["C:\\work\\private\\trace.txt", "evidence contains possible drive-absolute filesystem path"],
      ["\\\\server\\private-share\\trace.txt", "evidence contains possible UNC or device filesystem path"],
      ["/opt/private/trace.txt", "evidence contains possible Unix-absolute filesystem path"],
    ]) {
      const bypass = structuredClone(valid);
      bypass.claims.privatePath = privatePath;
      expect(validateEvidenceDocument(bypass)).toContain(expected);
    }
    for (const [payload, expected] of [
      ["root=C:\\work\\private.txt", "evidence contains possible drive-absolute filesystem path"],
      ["root:/opt/private.txt", "evidence contains possible Unix-absolute filesystem path"],
      ["path=[/home/alice/private.txt]", "evidence contains possible Unix-absolute filesystem path"],
      ["path,/opt/private.txt", "evidence contains possible Unix-absolute filesystem path"],
      ["path->/srv/private.txt", "evidence contains possible Unix-absolute filesystem path"],
      ["file:///C:/Users/alice/private.txt", "evidence contains possible drive-absolute filesystem path"],
      ["github" + "_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890", "evidence contains possible GitHub fine-grained token"],
      ["npm" + "_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "evidence contains possible npm token"],
    ]) {
      const bypass = structuredClone(valid);
      bypass.claims.payload = payload;
      expect(validateEvidenceDocument(bypass)).toContain(expected);
    }
  });

  it("stores only repo-relative allowlisted Vitest proof fields", () => {
    const outputRoot = fixtureRoot();
    const output = join(outputRoot, "sanitized-evidence.json");
    const secret = "SENSITIVE_FAILURE_PAYLOAD_THAT_MUST_NEVER_REACH_EVIDENCE";
    const absoluteSuitePath = join(process.cwd(), "test", "release-truth.test.ts");
    const document = writeVitestEvidence({
      root: process.cwd(),
      output,
      suite: "sanitization-fixture",
      command: "pnpm test:sanitization-fixture",
      requirementIds: ["A02"],
      facts: evidenceFacts({ job: "candidate-evidence" }),
      report: {
        numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
        success: true,
        testResults: [{
          name: absoluteSuitePath, status: "passed", startTime: 1, endTime: 2,
          message: `private trace ${absoluteSuitePath}`,
          assertionResults: [{
            fullName: "sanitization A02-REGRESSION", title: "A02-REGRESSION", status: "passed", duration: 1,
            failureMessages: [secret], meta: { secret },
          }],
        }],
      },
    });
    const serialized = readFileSync(output, "utf8");
    expect(serialized).not.toContain(process.cwd().replaceAll("\\", "/"));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("failureMessages");
    expect(document.attachments.map((item) => item.name)).toEqual(["vitest-proof"]);
    expect(document.test.cases).toEqual([{ path: "test/release-truth.test.ts", name: "sanitization A02-REGRESSION", status: "passed" }]);
    expect(validateEvidenceDocument(document)).toEqual([]);
  });

  it("redacts unsafe path and token substrings from execution case names", () => {
    const outputRoot = fixtureRoot();
    const output = join(outputRoot, "case-name-redaction.json");
    const document = writeVitestEvidence({
      root: process.cwd(), output, suite: "case-name-redaction", command: "pnpm test:case-name-redaction",
      requirementIds: ["A02"], facts: evidenceFacts({ job: "candidate-evidence" }),
      report: {
        numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
        testResults: [{
          name: join(process.cwd(), "test", "case-name-redaction.test.ts"), status: "passed", startTime: 1, endTime: 2,
          assertionResults: [{
            fullName: "redaction path=[/home/alice/private.txt] token=github" + "_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890",
            status: "passed", duration: 1,
          }],
        }],
      },
    });
    const serialized = readFileSync(output, "utf8");
    expect(serialized).not.toContain("/home/alice/private.txt");
    expect(serialized).not.toContain("github_pat_");
    expect(serialized).toContain("<redacted-path>");
    expect(serialized).toContain("<redacted-secret>");
    expect(validateEvidenceDocument(document)).toEqual([]);
  });

  it("redacts and bounds failure diagnostics before they can reach CI logs", () => {
    const diagnostic = [
      "at fixture (C:\\Users\\alice\\private\\fixture.test.ts:10:2)",
      "path=/home/alice/private.txt",
      "authorization: Bearer abcdefghijklmnop",
      "token=arbitrary-internal-token-value",
      "github" + "_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890",
      "https://alice:private-password@example.test/path",
      "x".repeat(2_000),
    ].join("\n");
    const sanitized = sanitizeDiagnosticText(diagnostic, { maxBytes: 512 });
    expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(512);
    expect(sanitized).toContain("<redacted-path>");
    expect(sanitized).toContain("<redacted-secret>");
    expect(sanitized).toContain("<redacted-credentials>");
    expect(sanitized).toContain("<diagnostic-truncated>");
    expect(sanitized).not.toMatch(/alice[\\/]private|Bearer abcdef|arbitrary-internal|github_pat_|private-password/);

    const truncatedPem = sanitizeDiagnosticText("failure payload:\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nunterminated-key-material");
    expect(truncatedPem).toBe("failure payload:\n<redacted-private-key>");
    expect(truncatedPem).not.toContain("unterminated-key-material");

    const safeUrl = "request failed: https://api.example.test/v1/models";
    expect(sanitizeDiagnosticText(safeUrl)).toBe(safeUrl);

    const credentialUrls = "postgres://alice:database-password@example.test/db redis://:cache-password@example.test/0";
    const sanitizedUrls = sanitizeDiagnosticText(credentialUrls);
    expect(sanitizedUrls).toBe("postgres://<redacted-credentials>@example.test/db redis://<redacted-credentials>@example.test/0");
    expect(sanitizedUrls).not.toMatch(/database-password|cache-password/);

    expect(sanitizeDiagnosticText("Error:/home/alice/private.txt")).toBe("Error:<redacted-path>");
  });

  it("makes the explicit CI evidence scan reject embedded paths and current token formats", () => {
    const root = fixtureRoot();
    const path = join(root, "unsafe-evidence.json");
    writeJson(path, {
      drive: "root=C:\\work\\private.txt",
      unc: "\\\\server\\private-share\\trace.txt",
      unix: "root:/opt/private.txt",
      unixBracket: "path=[/home/alice/private.txt]",
      unixComma: "path,/opt/private.txt",
      unixArrow: "path->/srv/private.txt",
      fileUri: "file:///C:/Users/alice/private.txt",
      github: "github" + "_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890",
      npm: "npm" + "_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    });
    const result = spawnSync(process.execPath, ["scripts/check-secrets.mjs", "--include", path, "--evidence"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drive-absolute filesystem path");
    expect(result.stderr).toContain("UNC or device filesystem path");
    expect(result.stderr).toContain("Unix-absolute filesystem path");
    expect(result.stderr).toContain("GitHub fine-grained token");
    expect(result.stderr).toContain("npm token");
  });

  it("reconstructs downloaded artifacts at every ledger evidence path", () => {
    const root = fixtureRoot();
    const sourceRoot = join(root, "downloads");
    const targetRoot = join(root, "checkout");
    for (const [source, target] of candidateEvidenceLayout) writeJson(join(sourceRoot, source), { target });

    expect(assembleCandidateEvidence(sourceRoot, targetRoot)).toHaveLength(candidateEvidenceLayout.length);
    for (const [, target] of candidateEvidenceLayout) {
      expect(JSON.parse(readFileSync(join(targetRoot, target), "utf8"))).toEqual({ target });
    }
  });

  it("keeps the CI artifact layout identical to every m1-m11 ledger reference", () => {
    const requirements = JSON.parse(readFileSync(join(process.cwd(), "docs/requirements/alpha-ledger.yaml"), "utf8"));
    const defects = JSON.parse(readFileSync(join(process.cwd(), "docs/requirements/defect-ledger.yaml"), "utf8"));
    const referenced = new Set<string>();
    for (const row of requirements.requirements) {
      for (const artifact of row.evidenceArtifacts ?? []) if (artifact.path.startsWith("evidence/m")) referenced.add(artifact.path);
    }
    for (const defect of defects.defects) {
      const path = defect.regression?.evidenceArtifact?.path;
      if (path?.startsWith("evidence/m")) referenced.add(path);
    }
    expect(candidateEvidenceLayout.map(([, target]) => target).sort()).toEqual([...referenced].sort());
    for (const row of requirements.requirements) {
      for (const artifact of row.evidenceArtifacts ?? []) {
        if (!artifact.path.startsWith("evidence/m")) continue;
        const registered = candidateEvidenceProducer(artifact.path);
        expect(registered, artifact.path).not.toBeNull();
        expect(canonicalProducer(artifact.producer)).toBe(registered?.producer);
        expect(row.ciJob).toBe(registered?.ciJob);
      }
    }
  });

  it("fails closed when any producer artifact is absent", () => {
    const root = fixtureRoot();
    expect(() => assembleCandidateEvidence(join(root, "downloads"), join(root, "checkout")))
      .toThrow("Missing candidate evidence artifacts");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lite-release-truth-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function passEvidence({
  commit = candidateCommit,
  tree = candidateTree,
  requirementIds = [],
  regressionIds = [],
  attachments = [],
  command = "pnpm test:fixture",
  job = "candidate-evidence",
  provider = "github-actions",
  cases = [{ path: "regression.test.ts", name: "fixture-case", status: "passed" as const }],
}: {
  commit?: string;
  tree?: string;
  requirementIds?: string[];
  regressionIds?: string[];
  attachments?: Array<{ name: string; mediaType: string; sha256: string; content: unknown }>;
  command?: string;
  job?: string | null;
  provider?: string | null;
  cases?: Array<{ path: string; name: string; status: "passed" | "failed" | "skipped" | "todo" | "blocked" }>;
}) {
  return createEvidenceDocument({
    root: "unused",
    kind: "policy-check",
    suite: "fixture-suite",
    command,
    result: "pass",
    counts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
    durationMs: 1,
    cases,
    requirementIds,
    regressionIds,
    claims: {
      assertions: Object.fromEntries(cases.map((item) => [item.name, item.status === "passed"])),
      policyProof: {
        sourcePath: cases[0]?.path ?? "regression.test.ts",
        caseBindings: Object.fromEntries(cases.map((item) => [item.name, [item.name]])),
      },
    },
    attachments,
    facts: evidenceFacts({ commit, tree, provider, job }),
  });
}

function evidenceFacts({
  commit = candidateCommit,
  tree = candidateTree,
  provider = "github-actions",
  job = "candidate-evidence",
}: { commit?: string; tree?: string; provider?: string | null; job?: string | null } = {}) {
  return {
    commit,
    tree,
    dirty: false,
    at: "2026-07-15T00:00:00.000Z",
    platform: { os: "test", release: "1", architecture: "x64", cpu: "fixture", logicalCpus: 1 },
    runtime: {
      node: "v24.0.0",
      pnpm: "11.7.0",
      docker: {
        available: false,
        context: null,
        clientVersion: null,
        serverVersion: null,
        serverOs: null,
        serverArchitecture: null,
        platform: null,
        kernel: null,
      },
    },
    ci: {
      provider,
      workflow: provider ? "CI" : null,
      job,
      runId: provider ? "1" : null,
      runAttempt: provider ? "1" : null,
    },
  };
}

function canonicalProducer(producer: string) {
  return producer.replace(/\s+--\s+--evidence(?:\s+\S+)?\s*$/, "").trim();
}
