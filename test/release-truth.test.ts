import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCandidateEvidence, candidateEvidenceLayout } from "../scripts/assemble-ci-evidence.mjs";
import { defectClosureFailures, evaluateReleaseTruth, requirementVerificationFailures } from "../scripts/release-truth-lib.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release truth", () => {
  it("requires current zero-skip evidence to name the exact requirement", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "implementation.ts"), "export {};\n");
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    writeJson(join(root, "evidence.json"), {
      commit: "candidate", result: "pass", skips: 0, testIds: ["A02"],
    });
    const row = {
      id: "A02", status: "verified", implementationPaths: ["implementation.ts"],
      testIds: ["A02-REGRESSION"], ciJob: "candidate-evidence",
      evidenceArtifacts: [{ path: "evidence.json", producer: "pnpm test:sdk" }], blockers: [],
    };
    expect(requirementVerificationFailures(row, { root, head: "candidate" })).toEqual([]);

    writeJson(join(root, "evidence.json"), {
      commit: "candidate", result: "pass", skips: 0, testIds: ["some-other-row"],
    });
    expect(requirementVerificationFailures(row, { root, head: "candidate" }))
      .toContain("evidence does not name requirement A02: evidence.json");
  });

  it("refuses a closed defect whose regression evidence targets another commit", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    writeJson(join(root, "evidence.json"), {
      commit: "parent", result: "pass", skips: 0, testIds: ["BD-063-REGRESSION"],
    });
    const defect = {
      id: "BD-063", status: "closed", blockers: [],
      regression: {
        testId: "BD-063-REGRESSION", path: "regression.test.ts", result: "pass",
        evidenceArtifact: { path: "evidence.json" },
      },
    };
    expect(defectClosureFailures(defect, { root, head: "candidate" }))
      .toContain("closed without current zero-skip evidence");
  });

  it("keeps stale verified rows and unproven closures in every truth summary", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "implementation.ts"), "export {};\n");
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    writeJson(join(root, "evidence.json"), {
      commit: "parent", result: "pass", skips: 0, testIds: ["A02", "BD-063-REGRESSION"],
    });
    const requirement = {
      id: "A02", status: "verified", implementationPaths: ["implementation.ts"],
      testIds: ["A02-REGRESSION"], ciJob: "candidate-evidence",
      evidenceArtifacts: [{ path: "evidence.json", producer: "pnpm test:sdk" }], blockers: [],
    };
    const defect = {
      id: "BD-063", status: "closed", blockers: [],
      regression: {
        testId: "BD-063-REGRESSION", path: "regression.test.ts", result: "pass",
        evidenceArtifact: { path: "evidence.json" },
      },
    };
    const summary = evaluateReleaseTruth({ requirements: [requirement], defects: [defect] }, { root, head: "candidate" });
    expect(summary.requirementEvaluations[0]?.verified).toBe(false);
    expect(summary.defectEvaluations[0]?.closed).toBe(false);
  });

  it("labels architecture and blocker documents as unverified", () => {
    expect(readFileSync(join(process.cwd(), "docs", "ARCHITECTURE.md"), "utf8"))
      .toContain("NOT YET A VERIFIED ALPHA");
    expect(readFileSync(join(process.cwd(), "BLOCKERS.md"), "utf8"))
      .toContain("NOT YET A VERIFIED ALPHA");
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
