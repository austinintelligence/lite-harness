import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateCandidateEvidence, isExternalHandoffOnlyAggregate } from "../scripts/aggregate-ci-evidence.mjs";
import { createEvidenceDocument, missingExternalGates, validateEvidenceDocument } from "../scripts/evidence-lib.mjs";

const roots: string[] = [];
const facts = {
  commit: "a".repeat(40),
  tree: "b".repeat(40),
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
  ci: { provider: "github-actions", workflow: "CI", job: "aggregate", runId: "1", runAttempt: "1" },
};
const fixtureCatalog = [
  catalogEntry("evidence/a.json", "suite-a"),
  catalogEntry("evidence/b.json", "suite-b"),
  catalogEntry("evidence/dirty.json", "dirty-suite"),
];
const completeLedgerQualification = {
  available: true,
  requirements: { total: 1, unverifiedIds: [] },
  defects: { total: 1, openIds: [] },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("candidate evidence aggregation", () => {
  it("binds every input digest and keeps a blocked suite release-blocking", () => {
    const root = fixtureRoot();
    const paths = ["evidence/a.json", "evidence/b.json"];
    writeJson(join(root, paths[0]), envelope("suite-a", "pass", ["A02"]));
    writeJson(join(root, paths[1]), envelope("suite-b", "blocked", [], ["BD-059-REGRESSION"]));

    const aggregate = aggregateCandidateEvidence({ root, paths, facts, ledgerQualification: completeLedgerQualification, catalog: fixtureCatalog });
    expect(aggregate.test).toMatchObject({ result: "blocked", counts: { failed: 0, todo: 13 } });
    expect(aggregate.attachments).toHaveLength(2);
    expect(aggregate.claims.blockedSuites).toEqual(["suite-b"]);
    expect(aggregate.claims.candidateId).toMatch(/^[a-f0-9]{64}$/);
    expect(aggregate.claims.evidenceSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validateEvidenceDocument(aggregate, {
      expectedCommit: facts.commit,
      expectedTree: facts.tree,
      requireClean: true,
    })).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "evidence/candidate/manifest.json"), "utf8"))).toEqual(aggregate);
  });

  it("rejects an input captured from a dirty worktree", () => {
    const root = fixtureRoot();
    const path = "evidence/dirty.json";
    const document = envelope("dirty-suite", "pass", ["A02"]);
    document.subject.source.dirty = true;
    writeJson(join(root, path), document);
    expect(() => aggregateCandidateEvidence({ root, paths: [path], facts, catalog: fixtureCatalog })).toThrow("source worktree was dirty");
  });

  it("rejects conflicting digests for the same candidate artifact name", () => {
    const root = fixtureRoot();
    const paths = ["evidence/a.json", "evidence/b.json"];
    const first = envelope("suite-a", "pass", ["A02"]);
    const second = envelope("suite-b", "pass", ["A02"]);
    first.subject.packages = [{ name: "sdk.tgz", sha256: "1".repeat(64) }];
    second.subject.packages = [{ name: "sdk.tgz", sha256: "2".repeat(64) }];
    first.subject.scope = "candidate-artifact";
    second.subject.scope = "candidate-artifact";
    writeJson(join(root, paths[0]), first);
    writeJson(join(root, paths[1]), second);
    expect(() => aggregateCandidateEvidence({ root, paths, facts, catalog: fixtureCatalog })).toThrow("conflicting digests");
  });

  it("qualifies an all-pass aggregate only when suites, external gates, and ledgers are complete", () => {
    const root = fixtureRoot();
    const paths = ["evidence/a.json", "evidence/b.json"];
    writeJson(join(root, paths[0]), envelope("suite-a", "pass", ["A02"]));
    writeJson(join(root, paths[1]), envelope("suite-b", "pass", [], ["BD-057-REGRESSION"]));
    const { authorities, paths: gatePaths } = writePassingGateEvidence(root);

    const aggregate = aggregateCandidateEvidence({
      root,
      paths: [...paths, ...gatePaths],
      facts,
      ledgerQualification: completeLedgerQualification,
      catalog: fixtureCatalog,
      gateAuthorities: authorities,
    });
    expect(aggregate.test.result).toBe("pass");
    expect(aggregate.test.cases).toHaveLength(28);
    expect(aggregate.test.cases.every((item) => item.status === "passed")).toBe(true);
    expect(validateEvidenceDocument(aggregate, {
      expectedCommit: facts.commit,
      expectedTree: facts.tree,
      requireClean: true,
    })).toEqual([]);
  });

  it("keeps mandatory external gates release-blocking even when every suite passes", () => {
    const root = fixtureRoot();
    const path = "evidence/a.json";
    const document = envelope("suite-a", "pass", ["A02"]);
    document.externalGates = { ...missingExternalGates };
    writeJson(join(root, path), document);

    const aggregate = aggregateCandidateEvidence({
      root, paths: [path], facts, ledgerQualification: completeLedgerQualification, catalog: fixtureCatalog,
    });
    expect(aggregate.test.result).toBe("blocked");
    expect(isExternalHandoffOnlyAggregate(aggregate)).toBe(true);
    expect(aggregate.claims).toMatchObject({ releaseQualification: { externalGates: missingExternalGates } });
  });

  it("keeps explicit external-only ledger rows out of local failures", () => {
    const root = fixtureRoot();
    const path = "evidence/a.json";
    writeJson(join(root, path), envelope("suite-a", "pass", ["A02"]));

    const aggregate = aggregateCandidateEvidence({
      root,
      paths: [path],
      facts,
      catalog: fixtureCatalog,
      ledgerQualification: {
        available: true,
        requirements: { total: 2, unverifiedIds: [], externalOnlyIds: ["A01"] },
        defects: { total: 2, openIds: [], externalOnlyIds: ["BD-058"] },
      },
    });

    expect(aggregate.test.result).toBe("blocked");
    expect(aggregate.claims).toMatchObject({
      releaseQualification: {
        ledger: {
          requirements: { unverifiedIds: [], externalOnlyIds: ["A01"] },
          defects: { openIds: [], externalOnlyIds: ["BD-058"] },
        },
      },
    });
    expect(aggregate.test.cases.find((item) => item.name === "all required requirements verified")?.status).toBe("passed");
    expect(aggregate.test.cases.find((item) => item.name === "all critical and high defects closed")?.status).toBe("passed");
  });

  it("treats an ordinary suite self-asserting external gates as an unauthorized failure", () => {
    const root = fixtureRoot();
    const path = "evidence/a.json";
    const document = envelope("suite-a", "pass", ["A02"]);
    document.externalGates = { ...missingExternalGates, windows11DockerDesktopWsl2: "pass" };
    writeJson(join(root, path), document);

    const aggregate = aggregateCandidateEvidence({
      root, paths: [path], facts, ledgerQualification: completeLedgerQualification, catalog: fixtureCatalog,
    });
    expect(aggregate.test.result).toBe("fail");
    expect(aggregate.claims.unauthorizedGateClaims).toContainEqual({
      path, gate: "windows11DockerDesktopWsl2", value: "pass",
    });
    expect(aggregate.externalGates.windows11DockerDesktopWsl2).toBe("missing");
  });

  it("evaluates forged verified and closed ledger statuses through release truth", () => {
    const root = fixtureRoot();
    const path = "evidence/a.json";
    writeJson(join(root, path), envelope("suite-a", "pass", ["A02"]));
    writeFileSync(join(root, "implementation.ts"), "export {};\n");
    writeFileSync(join(root, "regression.test.ts"), "export {};\n");
    writeJson(join(root, "docs/requirements/alpha-ledger.yaml"), {
      requirements: [{
        id: "A02", required: true, status: "verified", implementationPaths: ["implementation.ts"],
        testIds: ["A02-REGRESSION"], ciJob: "aggregate",
        evidenceArtifacts: [{ path: "evidence/missing-requirement.json", producer: "pnpm suite-a" }], blockers: [],
      }],
    });
    writeJson(join(root, "docs/requirements/defect-ledger.yaml"), {
      defects: [{
        id: "BD-057", severity: "high", status: "closed", blockers: [],
        regression: {
          testId: "BD-057-REGRESSION", path: "regression.test.ts", result: "pass",
          evidenceArtifact: { path: "evidence/missing-defect.json" },
        },
      }],
    });

    const aggregate = aggregateCandidateEvidence({ root, paths: [path], facts, catalog: fixtureCatalog });
    expect(aggregate.test.result).toBe("blocked");
    expect(aggregate.claims).toMatchObject({
      releaseQualification: {
        ledger: {
          method: "evaluateReleaseTruth",
          requirements: { unverifiedIds: ["A02"] },
          defects: { openIds: ["BD-057"] },
        },
      },
    });
  });

  it("still emits a fail manifest for invalid, missing, and failed producer inputs", () => {
    const root = fixtureRoot();
    const invalidPath = "evidence/invalid.json";
    mkdirSync(dirname(join(root, invalidPath)), { recursive: true });
    writeFileSync(join(root, invalidPath), "{not-json\n");

    const aggregate = aggregateCandidateEvidence({
      root,
      paths: [invalidPath],
      missingPaths: ["evidence/missing.json"],
      allowInvalid: true,
      facts,
      ledgerQualification: completeLedgerQualification,
      producerResults: { "suite-job": { result: "failure" } },
      catalog: fixtureCatalog,
    });
    expect(aggregate.test.result).toBe("fail");
    expect(aggregate.claims.invalidInputs).toEqual([{ path: invalidPath, reason: expect.any(String) }]);
    expect(aggregate.claims.missingPaths).toEqual(["evidence/missing.json"]);
    expect(aggregate.claims).toMatchObject({ releaseQualification: { producerJobs: { "suite-job": { result: "failure" } } } });
    expect(JSON.parse(readFileSync(join(root, "evidence/candidate/manifest.json"), "utf8"))).toEqual(aggregate);
  });

  it("rejects a schema-valid envelope at the wrong catalog producer, suite, kind, or CI job", () => {
    const root = fixtureRoot();
    const path = "evidence/a.json";
    const forged = envelope("forged-suite", "pass", ["A02"]);
    forged.kind = "aggregate";
    forged.test.command = "forged command";
    (forged.capture as { ci: { job: string } }).ci.job = "wrong-job";
    writeJson(join(root, path), forged);

    const aggregate = aggregateCandidateEvidence({
      root,
      paths: [path],
      allowInvalid: true,
      facts,
      ledgerQualification: completeLedgerQualification,
      catalog: fixtureCatalog,
    });
    expect(aggregate.test.result).toBe("fail");
    expect(aggregate.claims.invalidInputs).toEqual([{
      path,
      reason: expect.stringContaining("kind must be policy-check"),
    }]);
  });
});

function envelope(suite: string, result: "pass" | "blocked", requirementIds: string[], regressionIds: string[] = []) {
  const assertions = { [suite]: true };
  return createEvidenceDocument({
    root: "unused",
    kind: "policy-check",
    suite,
    command: `pnpm ${suite}`,
    result,
    counts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
    durationMs: 1,
    cases: [{ path: `test/${suite}.test.ts`, name: suite, status: "passed" }],
    requirementIds,
    regressionIds,
    claims: {
      assertions,
      policyProof: { sourcePath: `test/${suite}.test.ts`, caseBindings: { [suite]: [suite] } },
    },
    externalGates: missingExternalGates,
    facts,
  });
}

function writePassingGateEvidence(root: string) {
  const authorities = Object.fromEntries(Object.keys(missingExternalGates).map((gate) => [gate, {
    path: `evidence/gates/${gate}.json`,
    ciJob: `gate-${gate}`,
    os: null,
    architecture: null,
    kind: "policy-check" as const,
    scope: "external-platform" as const,
    suite: `external-${gate}`,
    producer: `pnpm evidence:external --gate ${gate}`,
  }]));
  const paths = [];
  for (const [gate, authority] of Object.entries(authorities)) {
    const externalGates = { ...missingExternalGates, [gate]: "pass" };
    const assertion = `external-${gate}`;
    const document = createEvidenceDocument({
      root: "unused",
      kind: "policy-check",
      suite: authority.suite,
      command: authority.producer,
      result: "pass",
      counts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
      durationMs: 1,
      cases: [{ path: `test/${gate}.test.ts`, name: assertion, status: "passed" }],
      requirementIds: ["A02"],
      claims: {
        assertions: { [assertion]: true },
        policyProof: { sourcePath: `test/${gate}.test.ts`, caseBindings: { [assertion]: [assertion] } },
      },
      externalGates,
      scope: "external-platform",
      facts: { ...facts, ci: { ...facts.ci, job: authority.ciJob } },
    });
    writeJson(join(root, authority.path), document);
    paths.push(authority.path);
  }
  return { authorities, paths };
}

function catalogEntry(target: string, suite: string) {
  return {
    source: target,
    target,
    ciJob: "aggregate",
    producer: `pnpm ${suite}`,
    kind: "policy-check" as const,
    suite,
  };
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "lite-evidence-aggregate-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
