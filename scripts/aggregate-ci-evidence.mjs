import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  candidateEvidenceCatalog,
  candidateEvidenceCatalogFailures,
  candidateEvidenceLayout,
  requiredExternalGateAuthorities,
} from "./assemble-ci-evidence.mjs";
import {
  captureFacts,
  createEvidenceDocument,
  embeddedAttachment,
  requiredExternalGateNames,
  validateEvidenceDocument,
  writeEvidenceFile,
} from "./evidence-lib.mjs";
import { evaluateReleaseTruth } from "./release-truth-lib.mjs";

export function aggregateCandidateEvidence({
  root,
  paths = candidateEvidenceLayout.map(([, target]) => target),
  missingPaths = [],
  allowInvalid = false,
  output = "evidence/candidate/manifest.json",
  facts = captureFacts(root),
  ledgerQualification,
  producerResults = {},
  fanInChecks = {},
  catalog = candidateEvidenceCatalog,
  gateAuthorities = requiredExternalGateAuthorities,
}) {
  const resolvedLedgerQualification = ledgerQualification ?? readLedgerQualification(root, facts);
  const entries = [];
  const invalidInputs = [];
  for (const path of paths) {
    try {
      const document = JSON.parse(readFileSync(resolve(root, path), "utf8"));
      const failures = validateEvidenceDocument(document, {
        expectedCommit: facts.commit,
        expectedTree: facts.tree,
        requireClean: true,
      });
      const authority = Object.values(gateAuthorities).find((item) => item.path === path);
      failures.push(...(authority
        ? externalAuthorityFailures(path, document, authority, facts.ci)
        : candidateEvidenceCatalogFailures(path, document, { catalog, expectedCi: facts.ci })));
      if (failures.length) throw new Error(failures.join("; "));
      entries.push({ path, document });
    } catch (error) {
      if (!allowInvalid) throw new Error(`${path} is not candidate-valid:\n- ${safeError(error, root)}`);
      invalidInputs.push({ path, reason: safeError(error, root) });
    }
  }

  const failed = entries.filter(({ document }) => document.test.result === "fail");
  const blocked = entries.filter(({ document }) => document.test.result === "blocked");
  const attachments = entries.map(({ path, document }) => embeddedAttachment(path, "application/vnd.lite-harness.evidence+json", document));
  let packages = [];
  let images = [];
  try {
    packages = uniqueArtifacts(entries.flatMap(({ document }) => document.subject.packages));
    images = uniqueArtifacts(entries.flatMap(({ document }) => document.subject.images));
  } catch (error) {
    if (!allowInvalid) throw error;
    invalidInputs.push({ path: "candidate-artifacts", reason: safeError(error, root) });
  }
  const requirementIds = [...new Set(entries.flatMap(({ document }) => document.coverage.requirementIds))].sort();
  const regressionIds = [...new Set(entries.flatMap(({ document }) => document.coverage.regressionIds))].sort();
  const manifest = attachments.map((attachment, index) => ({
    path: entries[index].path,
    evidenceId: entries[index].document.evidenceId,
    suite: entries[index].document.test.suite,
    result: entries[index].document.test.result,
    sha256: attachment.sha256,
  }));
  const { externalGates, unauthorizedGateClaims } = qualifyExternalGates(entries, gateAuthorities);
  const externalGateCases = requiredExternalGateNames.map((name) => ({
    path: gateAuthorities[name].path,
    name,
    status: externalGates[name] === "pass" ? "passed" : externalGates[name] === "fail" ? "failed" : "blocked",
  }));
  const inputCases = entries.map(({ path, document }) => ({
    path,
    name: document.test.suite,
    status: document.test.result === "pass" ? "passed" : document.test.result === "fail" ? "failed" : "blocked",
  }));
  const incompleteCases = [
    ...missingPaths.map((path) => ({ path, name: "missing candidate evidence", status: "blocked" })),
    ...invalidInputs.map(({ path }) => ({ path, name: "invalid candidate evidence", status: "failed" })),
    ...unauthorizedGateClaims.map(({ path, gate }) => ({ path, name: `unauthorized external gate claim: ${gate}`, status: "failed" })),
  ];
  const ledgerCases = resolvedLedgerQualification.available
    ? [
        {
          path: "docs/requirements/alpha-ledger.yaml",
          name: "all required requirements verified",
          status: resolvedLedgerQualification.requirements.unverifiedIds.length ? "blocked" : "passed",
        },
        {
          path: "docs/requirements/defect-ledger.yaml",
          name: "all critical and high defects closed",
          status: resolvedLedgerQualification.defects.openIds.length ? "blocked" : "passed",
        },
      ]
    : [{ path: "docs/requirements", name: "release ledgers available", status: "blocked" }];
  const producerCases = Object.entries(producerResults).map(([job, value]) => ({
    path: "ci/jobs",
    name: job,
    status: value?.result === "success" ? "passed" : value?.result === "failure" ? "failed" : "blocked",
  }));
  const fanInCases = Object.entries(fanInChecks).map(([check, outcome]) => ({
    path: "ci/fan-in-checks",
    name: check,
    status: outcome === "success" ? "passed" : outcome === "failure" ? "failed" : "blocked",
  }));
  const cases = [...inputCases, ...incompleteCases, ...externalGateCases, ...ledgerCases, ...producerCases, ...fanInCases];
  const counts = {
    total: cases.length,
    passed: cases.filter(({ status }) => status === "passed").length,
    failed: cases.filter(({ status }) => status === "failed").length,
    skipped: 0,
    todo: cases.filter(({ status }) => status === "blocked").length,
  };
  const result = counts.failed ? "fail" : counts.todo ? "blocked" : "pass";
  const candidateId = sha256Json({ sourceTreeOid: facts.tree, packages, images });
  const evidenceSetSha256 = sha256Json({
    manifest,
    missingPaths,
    invalidInputs,
    unauthorizedGateClaims,
    externalGates,
    ledgerQualification: resolvedLedgerQualification,
    producerResults,
    fanInChecks,
  });
  const document = createEvidenceDocument({
    root,
    kind: "aggregate",
    suite: "candidate-evidence-aggregate",
    command: "pnpm aggregate:evidence",
    result,
    counts,
    durationMs: 0,
    cases,
    requirementIds,
    regressionIds,
    claims: {
      candidateId,
      evidenceSetSha256,
      manifest,
      missingPaths,
      invalidInputs,
      unauthorizedGateClaims,
      blockedSuites: blocked.map(({ document: item }) => item.test.suite),
      failedSuites: failed.map(({ document: item }) => item.test.suite),
      releaseQualification: {
        externalGates,
        ledger: resolvedLedgerQualification,
        producerJobs: producerResults,
        fanInChecks,
      },
    },
    packages,
    images,
    attachments,
    externalGates,
    facts,
  });
  writeEvidenceFile(resolve(root, output), document);
  return document;
}

export function isExternalHandoffOnlyAggregate(document) {
  if (document?.test?.result !== "blocked") return false;
  const cases = Array.isArray(document.test.cases) ? document.test.cases : [];
  const blockedCases = cases.filter(({ status }) => status === "blocked");
  const failedCases = cases.filter(({ status }) => status === "failed");
  const ledger = document.claims?.releaseQualification?.ledger;
  return blockedCases.length > 0 && failedCases.length === 0 &&
    (ledger?.requirements?.unverifiedIds ?? []).length === 0 &&
    (ledger?.defects?.openIds ?? []).length === 0 &&
    blockedCases.every(({ path }) => typeof path === "string" && path.startsWith("evidence/external/"));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, "..");
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--output requires a path");
  const expectedPaths = [
    ...candidateEvidenceCatalog.map(({ target }) => target),
    ...Object.values(requiredExternalGateAuthorities).map(({ path }) => path),
  ];
  const paths = expectedPaths.filter((path) => existsSync(resolve(root, path)));
  const missingPaths = expectedPaths.filter((path) => !existsSync(resolve(root, path)));
  const document = aggregateCandidateEvidence({
    root,
    output,
    paths,
    missingPaths,
    allowInvalid: true,
    producerResults: parseProducerResults(process.env.NEEDS_JSON),
    fanInChecks: parseCheckResults(process.env.FANIN_CHECKS_JSON),
  });
  const externalHandoffOnly = isExternalHandoffOnlyAggregate(document);
  process.stdout.write(`Aggregated candidate qualification with ${paths.length} available and ${missingPaths.length} missing evidence envelopes (${document.test.result}${externalHandoffOnly ? "; external handoff only" : ""}).\n`);
  if (document.test.result !== "pass" && !externalHandoffOnly) process.exitCode = 1;
}

function uniqueArtifacts(artifacts) {
  const byName = new Map();
  for (const artifact of artifacts) {
    const existing = byName.get(artifact.name);
    if (existing && existing.sha256 !== artifact.sha256) {
      throw new Error(`Candidate artifact ${artifact.name} has conflicting digests ${existing.sha256} and ${artifact.sha256}`);
    }
    byName.set(artifact.name, artifact);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function readLedgerQualification(root, facts) {
  try {
    const requirements = JSON.parse(readFileSync(resolve(root, "docs/requirements/alpha-ledger.yaml"), "utf8"));
    const defects = JSON.parse(readFileSync(resolve(root, "docs/requirements/defect-ledger.yaml"), "utf8"));
    const truth = evaluateReleaseTruth(
      { requirements: requirements.requirements, defects: defects.defects },
      { root, head: facts.commit, tree: facts.tree },
    );
    const unverifiedIds = truth.requirementEvaluations
      .filter(({ row, verified, externalOnly }) => row.required === true && !verified && !externalOnly)
      .map(({ row }) => row.id);
    const requirementExternalOnlyIds = truth.requirementEvaluations
      .filter(({ row, externalOnly }) => row.required === true && externalOnly)
      .map(({ row }) => row.id);
    const openIds = truth.defectEvaluations
      .filter(({ defect, closed, externalOnly }) => ["critical", "high"].includes(defect.severity) && !closed && !externalOnly)
      .map(({ defect }) => defect.id);
    const defectExternalOnlyIds = truth.defectEvaluations
      .filter(({ defect, externalOnly }) => ["critical", "high"].includes(defect.severity) && externalOnly)
      .map(({ defect }) => defect.id);
    return {
      available: true,
      method: "evaluateReleaseTruth",
      requirements: { total: requirements.requirements.filter((row) => row.required === true).length, unverifiedIds, externalOnlyIds: requirementExternalOnlyIds },
      defects: { total: defects.defects.filter((defect) => ["critical", "high"].includes(defect.severity)).length, openIds, externalOnlyIds: defectExternalOnlyIds },
    };
  } catch (error) {
    return { available: false, reason: safeError(error, root) };
  }
}

function qualifyExternalGates(entries, authorities) {
  const unauthorizedGateClaims = [];
  const externalGates = Object.fromEntries(requiredExternalGateNames.map((gate) => {
    const authority = authorities[gate];
    for (const { path, document } of entries) {
      if (path !== authority.path && ["pass", "fail"].includes(document.externalGates[gate])) {
        unauthorizedGateClaims.push({ path, gate, value: document.externalGates[gate] });
      }
    }
    const authoritative = entries.find(({ path }) => path === authority.path)?.document;
    if (!authoritative) return [gate, "missing"];
    if (authoritative.externalGates[gate] === "fail" || authoritative.test.result === "fail") return [gate, "fail"];
    if (authoritative.externalGates[gate] === "pass" && authoritative.test.result === "pass" &&
        authoritative.test.cases.some(({ status }) => status === "passed")) return [gate, "pass"];
    return [gate, "missing"];
  }));
  return { externalGates, unauthorizedGateClaims };
}

function externalAuthorityFailures(path, document, authority, expectedCi) {
  const failures = [];
  if (document.kind !== authority.kind) failures.push(`kind must be ${authority.kind}`);
  if (document.subject?.scope !== authority.scope) failures.push(`scope must be ${authority.scope}`);
  if (document.test?.suite !== authority.suite) failures.push(`suite must be ${authority.suite}`);
  if (document.test?.command !== authority.producer) failures.push(`command must be ${authority.producer}`);
  if (document.capture?.ci?.provider !== "github-actions") failures.push("capture provider must be github-actions");
  if (document.capture?.ci?.job !== authority.ciJob) failures.push(`capture job must be ${authority.ciJob}`);
  if (authority.os && document.capture?.platform?.os !== authority.os) failures.push(`platform os must be ${authority.os}`);
  if (authority.architecture && document.capture?.platform?.architecture !== authority.architecture) {
    failures.push(`platform architecture must be ${authority.architecture}`);
  }
  for (const key of ["workflow", "runId", "runAttempt"]) {
    if (!document.capture?.ci?.[key]) failures.push(`capture ${key} is required`);
    if (expectedCi?.[key] && document.capture?.ci?.[key] !== expectedCi[key]) failures.push(`capture ${key} does not match the candidate run`);
  }
  if (document.test?.result === "pass" && !document.test.cases?.some(({ status }) => status === "passed")) {
    failures.push(`external authority ${path} has no passed execution case`);
  }
  return failures;
}

function safeError(error, root) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(root.replaceAll("\\", "/"), "<repo>").replaceAll(root, "<repo>").slice(0, 1_000);
}

function parseProducerResults(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return Object.fromEntries(Object.entries(parsed).map(([job, result]) => [job, { result: result?.result ?? "unknown" }]));
  } catch {
    return { "producer-results": { result: "invalid" } };
  }
}

function parseCheckResults(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return Object.fromEntries(Object.entries(parsed).map(([check, outcome]) => [check, String(outcome)]));
  } catch {
    return { "fan-in-results": "invalid" };
  }
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
