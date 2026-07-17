import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateEvidenceDocument, writePolicyEvidence } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const reportRelativePath = "docs/pxpipe-paired-evaluation.json";
const reportPath = resolve(root, reportRelativePath);
const evidenceOutput = option("--evidence") ?? "evidence/m10/paired-context-evaluation.json";
const startedAt = performance.now();
const reportBytes = readFileSync(reportPath);
const report = JSON.parse(reportBytes.toString("utf8"));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const contextSource = readFileSync(resolve(root, "packages/context/src/index.ts"), "utf8");
const sourceCommit = typeof report.sourceCommit === "string" ? report.sourceCommit : "";
const evaluatedSourcePaths = [
  "scripts/evaluate-context.ts",
  "packages/context",
  "packages/provider-core",
  "packages/provider-openai-compatible",
];

const sourceCommitIsCommit = /^[0-9a-f]{40}$/.test(sourceCommit) && gitSucceeds(["cat-file", "-e", `${sourceCommit}^{commit}`]);
const sourceCommitIsAncestor = sourceCommitIsCommit && gitSucceeds(["merge-base", "--is-ancestor", sourceCommit, "HEAD"]);
const changedEvaluatedSources = sourceCommitIsAncestor
  ? gitOutput(["diff", "--name-only", `${sourceCommit}..HEAD`, "--", ...evaluatedSourcePaths]).split(/\r?\n/u).filter(Boolean)
  : ["source-commit-is-not-an-ancestor"];
const evaluations = Array.isArray(report.evaluations) ? report.evaluations : [];
const expectedAnswers = new Map([
  ["recovery-token", "LH-RECOVER-7Q4M"],
  ["fencing-token", "FENCE-2049-ZETA"],
]);
const taskIds = new Set(evaluations.map((evaluation) => evaluation?.taskId));
const taskBills = evaluations.flatMap((evaluation) => [evaluation?.text?.fullBill, evaluation?.optical?.fullBill]);
const textScores = evaluations.map((evaluation) => scoreAnswer(evaluation?.text?.answer, expectedAnswers.get(evaluation?.taskId)));
const opticalScores = evaluations.map((evaluation) => scoreAnswer(evaluation?.optical?.answer, expectedAnswers.get(evaluation?.taskId)));
const reportedTextScores = evaluations.map((evaluation) => evaluation?.text?.score);
const reportedOpticalScores = evaluations.map((evaluation) => evaluation?.optical?.score);
const aggregate = report.aggregate ?? {};
const conclusion = typeof aggregate.conclusion === "string" ? aggregate.conclusion.toLowerCase() : "";
const reportText = reportBytes.toString("utf8");
const behavioralContext = runBehavioralContextEvidence();

const assertions = {
  reportContractIsPairedModelEvidence:
    report.schemaVersion === 2 &&
    report.evaluationType === "paired-model-quality-cost" &&
    report.testId === "BD-050-REGRESSION" &&
    Number.isFinite(Date.parse(report.generatedAt)),
  evaluatedSourceCommitExists: sourceCommitIsCommit,
  evaluatedSourceCommitIsAncestor: sourceCommitIsAncestor,
  evaluatedSourcesAreUnchanged: changedEvaluatedSources.length === 0,
  hermesRouteIsPinned:
    report.provider?.route === "local-hermes-openai-compatible" &&
    report.provider?.baseUrl === "http://127.0.0.1:8645/v1" &&
    report.provider?.model === "gpt-5.6-luna",
  credentialIsPlaceholderOnly:
    report.provider?.credential === "non-empty-placeholder-only" &&
    !reportText.includes("apiKey") &&
    !reportText.includes("authorization"),
  pxpipeRevisionIsPinned:
    report.pxpipe?.version === "0.8.0" &&
    report.pxpipe?.commit === "7dd54d395d119f5f822da5c1944ba5afbb02fa88" &&
    packageJson.optionalDependencies?.["pxpipe-proxy"] === "0.8.0" &&
    contextSource.includes('PXPIPE_EVALUATED_VERSION = "0.8.0"') &&
    contextSource.includes('PXPIPE_EVALUATED_COMMIT = "7dd54d395d119f5f822da5c1944ba5afbb02fa88"'),
  behavioralContextSuiteIsZeroSkip: behavioralContext.valid,
  measurementPolicyIsDisabledByDefault:
    report.policy === "measurement-only-disabled-by-default" && behavioralContext.defaultOffExecuted,
  representativePairedTasksArePresent:
    evaluations.length === expectedAnswers.size &&
    taskIds.size === evaluations.length &&
    taskIds.has("recovery-token") &&
    taskIds.has("fencing-token"),
  benchmarkDefinitionsArePinned:
    evaluations.length === expectedAnswers.size &&
    evaluations.every((evaluation) => evaluation?.expected === expectedAnswers.get(evaluation?.taskId)),
  exactRecoveryIsVerified:
    evaluations.length === expectedAnswers.size &&
    evaluations.every((evaluation) => evaluation?.exactRecoveryVerified === true) &&
    behavioralContext.durableRecoveryAndFallbackExecuted &&
    behavioralContext.selectedVisionRouteExecuted,
  nativeAndFailureFallbacksAreVerified:
    behavioralContext.durableRecoveryAndFallbackExecuted &&
    behavioralContext.nativeEligibilityExecuted &&
    behavioralContext.opticalProviderFallbackExecuted,
  reportedQualityScoresMatchAnswers:
    evaluations.length === expectedAnswers.size &&
    reportedTextScores.every((score, index) => score === textScores[index]) &&
    reportedOpticalScores.every((score, index) => score === opticalScores[index]),
  qualityScoresAreBounded:
    [...textScores, ...opticalScores].length >= 4 &&
    [...textScores, ...opticalScores].every((score) => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1),
  aggregateQualityMatchesTasks:
    nearlyEqual(aggregate.textQuality, average(textScores)) &&
    nearlyEqual(aggregate.opticalQuality, average(opticalScores)) &&
    nearlyEqual(aggregate.qualityDelta, aggregate.opticalQuality - aggregate.textQuality),
  taskAccountingIsExplicitlyNonAuthoritative:
    taskBills.length >= 4 && taskBills.every(isExplicitlyUnreportedBill),
  aggregateAccountingIsExplicitlyNonAuthoritative:
    aggregate.authoritativeAccounting === false &&
    isExplicitlyUnreportedBill(aggregate.textFullBill) &&
    isExplicitlyUnreportedBill(aggregate.opticalFullBill) &&
    aggregate.inputTokensIncludeProviderBilledImageTokens === false,
  unsupportedSavingsClaimIsAbsent:
    !Object.hasOwn(aggregate, "savingsPercent") &&
    !Object.hasOwn(aggregate, "costSavingsPercent") &&
    conclusion.includes("no authoritative usage fields") &&
    conclusion.includes("savings") &&
    conclusion.includes("prohibited"),
  productionPromotionRemainsDisabled:
    aggregate.promotionEligible === false &&
    aggregate.opticalQuality <= aggregate.textQuality &&
    conclusion.includes("production promotion") &&
    conclusion.includes("prohibited"),
};

const assertionNames = Object.keys(assertions);
writePolicyEvidence({
  root,
  output: evidenceOutput,
  suite: "m10-paired-context-evaluation",
  command: "pnpm check:pxpipe-evidence",
  assertions,
  requirementIds: ["P10", "R18-1678", "R18-1718", "R18-1724", "R34-2989"],
  regressionIds: ["BD-050-REGRESSION"],
  durationMs: performance.now() - startedAt,
  sourcePath: "scripts/check-paired-context-evidence.mjs",
  caseBindings: {
    "BD-050-REGRESSION": assertionNames,
    P10: ["behavioralContextSuiteIsZeroSkip", "exactRecoveryIsVerified", "measurementPolicyIsDisabledByDefault", "nativeAndFailureFallbacksAreVerified", "productionPromotionRemainsDisabled"],
    "R18-1678": ["behavioralContextSuiteIsZeroSkip", "measurementPolicyIsDisabledByDefault", "productionPromotionRemainsDisabled"],
    "R18-1718": ["reportContractIsPairedModelEvidence", "evaluatedSourcesAreUnchanged", "representativePairedTasksArePresent", "benchmarkDefinitionsArePinned", "reportedQualityScoresMatchAnswers"],
    "R18-1724": ["evaluatedSourcesAreUnchanged", "pxpipeRevisionIsPinned"],
    "R34-2989": ["taskAccountingIsExplicitlyNonAuthoritative", "aggregateAccountingIsExplicitlyNonAuthoritative", "unsupportedSavingsClaimIsAbsent"],
  },
  claims: {
    evaluationReport: {
      path: reportRelativePath,
      sha256: createHash("sha256").update(reportBytes).digest("hex"),
      generatedAt: report.generatedAt,
      sourceCommit,
      evaluatedSourcePaths,
    },
    provider: {
      route: report.provider?.route,
      endpoint: "local-loopback-openai-compatible-v1",
      model: report.provider?.model,
      credential: report.provider?.credential,
    },
    pxpipe: report.pxpipe,
    evaluation: {
      tasks: evaluations.length,
      textQuality: aggregate.textQuality,
      opticalQuality: aggregate.opticalQuality,
      authoritativeAccounting: aggregate.authoritativeAccounting,
      promotionEligible: aggregate.promotionEligible,
      savingsClaim: "prohibited",
    },
    behavioralContext: {
      suite: "m10-context-optimization",
      proofSha256: behavioralContext.proofSha256,
      counts: behavioralContext.counts,
      defaultOffExecuted: behavioralContext.defaultOffExecuted,
      durableRecoveryAndFallbackExecuted: behavioralContext.durableRecoveryAndFallbackExecuted,
      nativeEligibilityExecuted: behavioralContext.nativeEligibilityExecuted,
      selectedVisionRouteExecuted: behavioralContext.selectedVisionRouteExecuted,
      opticalProviderFallbackExecuted: behavioralContext.opticalProviderFallbackExecuted,
    },
  },
});

const failedAssertions = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
if (failedAssertions.length) {
  throw new Error(`Paired context evidence failed:\n${failedAssertions.map((name) => `- ${name}`).join("\n")}`);
}
process.stdout.write(`Paired context evidence passed (${assertionNames.length}/${assertionNames.length}, zero skips; promotion remains disabled).\n`);

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function gitSucceeds(args) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitOutput(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function average(values) {
  return values.length && values.every((value) => typeof value === "number" && Number.isFinite(value))
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : Number.NaN;
}

function nearlyEqual(left, right) {
  return typeof left === "number" && Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-12;
}

function scoreAnswer(answer, expected) {
  if (typeof answer !== "string" || typeof expected !== "string") return Number.NaN;
  return normalizeAnswer(answer) === normalizeAnswer(expected) ? 1 : 0;
}

function normalizeAnswer(value) {
  return value.trim().replace(/^['"`]|['"`]$/gu, "").toUpperCase();
}

function isExplicitlyUnreportedBill(bill) {
  return bill?.usageReported === false &&
    bill.inputTokens === null &&
    bill.outputTokens === null &&
    bill.cachedInputTokens === null &&
    typeof bill.accountingNote === "string" &&
    (bill.accountingNote.toLowerCase().includes("unknown") || bill.accountingNote.toLowerCase().includes("intentionally null"));
}

function runBehavioralContextEvidence() {
  const temporary = mkdtempSync(resolve(tmpdir(), "lite-paired-context-"));
  const evidencePath = resolve(temporary, "context-optimization.json");
  try {
    const run = spawnSync(process.execPath, [
      resolve(root, "scripts/check-context-optimization.mjs"),
      "--evidence", evidencePath,
    ], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (!existsSync(evidencePath)) return failedBehavioralContext();
    const proofBytes = readFileSync(evidencePath);
    const document = JSON.parse(proofBytes.toString("utf8"));
    const head = gitOutput(["rev-parse", "HEAD"]);
    const tree = gitOutput(["rev-parse", `${head}^{tree}`]);
    const validationFailures = validateEvidenceDocument(document, { expectedCommit: head, expectedTree: tree });
    const counts = document.test?.counts;
    const cases = Array.isArray(document.test?.cases) ? document.test.cases : [];
    const passedCase = (path, fragment) => cases.some((item) => item.path === path && item.status === "passed" && item.name.includes(fragment));
    const valid = run.status === 0 && validationFailures.length === 0 && document.test?.suite === "m10-context-optimization" &&
      document.test?.command === "pnpm test:context" && document.test?.result === "pass" &&
      document.coverage?.regressionIds?.includes("BD-050-REGRESSION") &&
      document.coverage?.requirementIds?.includes("P10") &&
      document.coverage?.requirementIds?.includes("R18-1678") &&
      counts?.total > 0 && counts.passed === counts.total && counts.failed === 0 && counts.skipped === 0 && counts.todo === 0;
    return {
      valid,
      proofSha256: createHash("sha256").update(proofBytes).digest("hex"),
      counts: counts ?? null,
      defaultOffExecuted: passedCase("test/optional-systems-manager.test.ts", "BD-050-REGRESSION keeps context optimization off by default and retains native text"),
      durableRecoveryAndFallbackExecuted: passedCase("test/context-optimization.test.ts", "BD-050-REGRESSION persists immutable exact canonical text"),
      nativeEligibilityExecuted: passedCase("test/capabilities.test.ts", "keeps canonical context exact and only renders eligible blocks for allowlisted models"),
      selectedVisionRouteExecuted: passedCase("test/optional-systems-manager.test.ts", "connects an explicitly classified semantic file to the selected vision route and exact recovery"),
      opticalProviderFallbackExecuted: passedCase("test/provider-core.test.ts", "fails closed instead of sending model-specific optical context to a fallback"),
    };
  } catch {
    return failedBehavioralContext();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function failedBehavioralContext() {
  return {
    valid: false,
    proofSha256: null,
    counts: null,
    defaultOffExecuted: false,
    durableRecoveryAndFallbackExecuted: false,
    nativeEligibilityExecuted: false,
    selectedVisionRouteExecuted: false,
    opticalProviderFallbackExecuted: false,
  };
}
