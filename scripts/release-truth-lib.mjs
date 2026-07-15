import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function currentCommit(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

export function requirementVerificationFailures(row, { root, head }) {
  const failures = [];
  const implementationPaths = Array.isArray(row.implementationPaths) ? row.implementationPaths : [];
  const testIds = Array.isArray(row.testIds) ? row.testIds : [];
  const evidenceArtifacts = Array.isArray(row.evidenceArtifacts) ? row.evidenceArtifacts : [];
  const blockers = Array.isArray(row.blockers) ? row.blockers : [];

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
      if (document.commit !== head) failures.push(`evidence is stale: ${document.commit ?? "no commit"} != ${head}`);
      if (document.result !== "pass" || document.skips !== 0) {
        failures.push(`evidence is not a zero-skip pass: ${artifact.path}`);
      }
      if (!Array.isArray(document.testIds) || !document.testIds.includes(row.id)) {
        failures.push(`evidence does not name requirement ${row.id}: ${artifact.path}`);
      }
    } catch {
      failures.push(`evidence is not valid JSON: ${artifact.path}`);
    }
  }
  return failures;
}

export function defectClosureFailures(defect, { root, head, checkFreshness = true }) {
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
    if (document.commit !== head || document.result !== "pass" || document.skips !== 0 ||
        !Array.isArray(document.testIds) || !document.testIds.includes(regression.testId)) {
      failures.push("closed without current zero-skip evidence");
    }
  } catch {
    failures.push("regression evidence is not valid JSON");
  }
  return failures;
}

export function evaluateReleaseTruth({ requirements, defects }, { root, head }) {
  const requirementEvaluations = requirements.map((row) => {
    const failures = requirementVerificationFailures(row, { root, head });
    return { row, failures, verified: failures.length === 0 };
  });
  const defectEvaluations = defects.map((defect) => {
    const failures = defect.status === "closed"
      ? defectClosureFailures(defect, { root, head })
      : [`is ${defect.status ?? "missing"}, not closed`];
    return { defect, failures, closed: failures.length === 0 };
  });
  return { requirementEvaluations, defectEvaluations };
}
