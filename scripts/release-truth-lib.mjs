import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidateEvidenceProducer } from "./assemble-ci-evidence.mjs";
import { validateEvidenceDocument } from "./evidence-lib.mjs";

export function currentCommit(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

export function currentTree(root, revision = "HEAD") {
  return execFileSync("git", ["rev-parse", `${revision}^{tree}`], { cwd: root, encoding: "utf8" }).trim();
}

export function requirementVerificationFailures(row, { root, head, tree = currentTree(root, head) }) {
  const failures = [];
  const implementationPaths = Array.isArray(row.implementationPaths) ? row.implementationPaths : [];
  const testIds = Array.isArray(row.testIds) ? row.testIds : [];
  const evidenceArtifacts = Array.isArray(row.evidenceArtifacts) ? row.evidenceArtifacts : [];
  const blockers = Array.isArray(row.blockers) ? row.blockers : [];
  const provedTestIds = new Set();

  if (row.status !== "verified") failures.push(`is ${row.status ?? "missing"}, not verified`);
  if (blockers.length) failures.push(`has unresolved blockers: ${blockers.join(", ")}`);
  if (!implementationPaths.length) failures.push("lacks production implementation paths");
  if (!testIds.length) failures.push("lacks runnable test IDs");
  if (!row.ciJob) failures.push("lacks a CI job");
  if (!evidenceArtifacts.length) failures.push("lacks current evidence artifacts");

  for (const path of implementationPaths) {
    if (!existsSync(resolve(root, path))) failures.push(`implementation path is missing: ${path}`);
  }
  for (const artifact of evidenceArtifacts) {
    if (!artifact || typeof artifact !== "object" || typeof artifact.path !== "string" || !artifact.path ||
        !existsSync(resolve(root, artifact.path))) {
      failures.push(`evidence artifact is missing: ${artifact?.path ?? "undefined"}`);
      continue;
    }
    try {
      const document = JSON.parse(readFileSync(resolve(root, artifact.path), "utf8"));
      const registered = candidateEvidenceProducer(artifact.path);
      const validationFailures = validateEvidenceDocument(document, { expectedCommit: head, expectedTree: tree, requireClean: true });
      if (validationFailures.length) {
        failures.push(`evidence is invalid: ${artifact.path} (${validationFailures.join("; ")})`);
      }
      if (document.test?.result !== "pass") {
        failures.push(`evidence is not a zero-skip pass: ${artifact.path}`);
      }
      if (!registered) {
        failures.push(`evidence path is not registered in the candidate catalog: ${artifact.path}`);
      } else if (canonicalProducer(artifact.producer) !== registered.producer || row.ciJob !== registered.ciJob) {
        failures.push(`ledger producer or CI job does not match the candidate catalog: ${artifact.path}`);
      }
      if (artifact.producer && document.test?.command !== canonicalProducer(artifact.producer)) {
        failures.push(`evidence producer command does not match ${artifact.producer}: ${artifact.path}`);
      }
      if (row.ciJob && (document.capture?.ci?.provider !== "github-actions" || document.capture.ci.job !== row.ciJob)) {
        failures.push(`evidence was not captured by required CI job ${row.ciJob}: ${artifact.path}`);
      }
      if (!Array.isArray(document.coverage?.requirementIds) || !document.coverage.requirementIds.includes(row.id)) {
        failures.push(`evidence does not name requirement ${row.id}: ${artifact.path}`);
      }
      for (const testId of testIds) if (executionCaseProves(document, testId)) provedTestIds.add(testId);
    } catch {
      failures.push(`evidence is not valid JSON: ${artifact.path}`);
    }
  }
  for (const testId of testIds) {
    if (!provedTestIds.has(testId)) failures.push(`no evidence execution case proves test ID ${testId}`);
  }
  return failures;
}

export function defectClosureFailures(defect, { root, head, tree = currentTree(root, head), checkFreshness = true }) {
  const failures = [];
  const regression = defect.regression;
  if (!regression?.path || !existsSync(resolve(root, regression.path))) {
    failures.push("closed without a regression test file");
  }
  if (regression?.result !== "pass") failures.push("closed without a passing regression");
  const evidence = regression?.evidenceArtifact;
  if (!evidence?.path) failures.push("closed without a regression evidence path");
  if (Array.isArray(defect.blockers) && defect.blockers.length) failures.push("closed with blockers");
  if (!checkFreshness) return failures;

  if (!evidence?.path || !existsSync(resolve(root, evidence.path))) {
    failures.push("closed without current zero-skip evidence");
    return failures;
  }
  try {
    const document = JSON.parse(readFileSync(resolve(root, evidence.path), "utf8"));
    const registered = candidateEvidenceProducer(evidence.path);
    const validationFailures = validateEvidenceDocument(document, { expectedCommit: head, expectedTree: tree, requireClean: true });
    if (!registered) failures.push("regression evidence path is not registered in the candidate catalog");
    if (registered && document.test?.command !== registered.producer) failures.push("regression evidence producer does not match the candidate catalog");
    if (registered && (document.capture?.ci?.provider !== "github-actions" || document.capture.ci.job !== registered.ciJob)) {
      failures.push(`regression evidence was not captured by required CI job ${registered.ciJob}`);
    }
    if (!executionCaseProves(document, regression.testId, regression.path)) {
      failures.push("regression evidence does not bind the test ID to the declared test path");
    }
    if (validationFailures.length || document.test?.result !== "pass" ||
        !Array.isArray(document.coverage?.regressionIds) || !document.coverage.regressionIds.includes(regression.testId)) {
      failures.push("closed without current zero-skip evidence");
    }
  } catch {
    failures.push("regression evidence is not valid JSON");
  }
  return failures;
}

export function evaluateReleaseTruth({ requirements, defects }, { root, head, tree = currentTree(root, head) }) {
  const requirementEvaluations = requirements.map((row) => {
    const failures = requirementVerificationFailures(row, { root, head, tree });
    return { row, failures, verified: failures.length === 0 };
  });
  const defectEvaluations = defects.map((defect) => {
    const failures = defect.status === "closed"
      ? defectClosureFailures(defect, { root, head, tree })
      : [`is ${defect.status ?? "missing"}, not closed`];
    return { defect, failures, closed: failures.length === 0 };
  });
  return { requirementEvaluations, defectEvaluations };
}

function canonicalProducer(producer) {
  return producer.replace(/\s+--\s+--evidence(?:\s+\S+)?\s*$/, "").trim();
}

function executionCaseProves(document, testId, expectedPath) {
  const expected = expectedPath?.replaceAll("\\", "/").replace(/^\.\//, "");
  const token = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(testId)}(?![A-Za-z0-9_-])`);
  return Array.isArray(document.test?.cases) && document.test.cases.some((item) =>
    item?.status === "passed" && token.test(item.name) && (!expected || item.path === expected));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
