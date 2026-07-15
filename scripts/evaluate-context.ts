import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  assertEvaluatedPxpipeVersion,
  ContextStore,
  OptionalPxpipeRenderer,
  PXPIPE_EVALUATED_COMMIT,
  PXPIPE_EVALUATED_VERSION,
  evaluateContextRenderer,
  type ContextBlock,
} from "@lite-harness/context";
import { officialOpenAiModelProfile, type ModelDescriptor, type ModelEvent, type ModelMessage } from "@lite-harness/provider-core";
import { OpenAICompatibleProvider } from "@lite-harness/provider-openai-compatible";

const root = process.cwd();
const argumentsSet = new Set(process.argv.slice(2));
const paired = argumentsSet.has("--paired-hermes");
const evidenceIndex = process.argv.indexOf("--evidence");
const evidencePath = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
const report = paired ? await pairedHermesModelEvaluation() : await localRenderEvaluation();
const output = resolve(root, evidencePath ?? "docs/pxpipe-evaluation.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function localRenderEvaluation(): Promise<Record<string, unknown>> {
  const corpora = [
    { id: "gateway-trace", kind: "logs" as const, path: "test/gateway-manager.e2e.test.ts" },
    { id: "architecture-trace", kind: "logs" as const, path: "docs/ARCHITECTURE.md" },
    { id: "provider-trace", kind: "logs" as const, path: "test/provider-adapters.test.ts" },
  ];
  const renderer = new OptionalPxpipeRenderer();
  const evaluations = [];
  for (const corpus of corpora) {
    const store = new ContextStore();
    try {
      const block = {
        id: corpus.id, kind: corpus.kind, exactText: readFileSync(join(root, corpus.path), "utf8"),
        lossyEligible: true, sensitive: false, provenance: corpus.path,
      };
      evaluations.push({ source: corpus.path, ...await evaluateContextRenderer(store, renderer, block, "measurement-only") });
    } finally { store.close(); }
  }
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(),
    sourceCommit: currentCommit(),
    pxpipe: { version: PXPIPE_EVALUATED_VERSION, commit: PXPIPE_EVALUATED_COMMIT },
    policy: "measurement-only-disabled-by-default",
    qualityConclusion: "Local rendering proves bounded rendering and durable exact recovery, not model quality or savings.",
    evaluations,
  };
}

/** Runs the paired quality/cost gate only through the required local Hermes proxy. */
export async function pairedHermesModelEvaluation(): Promise<Record<string, unknown>> {
  const baseUrl = requiredEnvironment("LITE_HARNESS_PROVIDER_BASE_URL");
  const apiKey = requiredEnvironment("LITE_HARNESS_PROVIDER_API_KEY");
  const modelId = requiredEnvironment("LITE_HARNESS_MODEL");
  if (process.env.LITE_HARNESS_PROVIDER !== "openai-compatible" || baseUrl !== "http://127.0.0.1:8645/v1" || modelId !== "gpt-5.6-luna") {
    throw new Error("Paired pxpipe evaluation must use the configured local Hermes gpt-5.6-luna route");
  }
  assertEvaluatedPxpipeVersion();
  const standardApiPricing = officialOpenAiModelProfile(modelId);
  if (!standardApiPricing) throw new Error(`No official pricing snapshot exists for ${modelId}`);
  const adapter = new OpenAICompatibleProvider({
    providerId: "openai-compatible", baseUrl, allowedOrigins: [new URL(baseUrl).origin], stream: false,
  });
  const model: ModelDescriptor = {
    id: modelId, providerId: "openai-compatible", transport: "direct", credentialProfileId: "hermes-local",
    capabilities: ["text", "vision"], contextWindow: 128_000, provenance: "operator", enabled: true,
  };
  const renderer = new OptionalPxpipeRenderer();
  const evaluations = [];
  for (const task of benchmarkTasks()) {
    const store = new ContextStore();
    try {
      const block: ContextBlock = {
        id: task.id, kind: "memory", exactText: task.reference,
        lossyEligible: true, sensitive: false, provenance: `benchmark:${task.id}`,
      };
      const rendered = await evaluateContextRenderer(store, renderer, block, modelId);
      const images = await renderer.render(block, modelId);
      const text = await runEvaluationTurn(adapter, model, apiKey, [
        { role: "system", content: "Use the supplied reference. Return only the requested exact token, with no punctuation or explanation." },
        { role: "user", content: task.reference }, { role: "user", content: task.question },
      ]);
      const optical = await runEvaluationTurn(adapter, model, apiKey, [
        { role: "system", content: "Use the supplied reference. Return only the requested exact token, with no punctuation or explanation." },
        { role: "user", content: `Optical context ${task.id}; exact canonical text is retained for recovery.`, imageDataUrls: images },
        { role: "user", content: task.question },
      ]);
      evaluations.push({
        taskId: task.id, expected: task.expected,
        exactRecoveryVerified: rendered.exactRecoveryVerified && store.fetchExact(task.id) === task.reference,
        render: { pages: rendered.pages, imageBytes: rendered.imageBytes, milliseconds: rendered.renderMilliseconds },
        text: scoredRun(text, task.expected), optical: scoredRun(optical, task.expected),
      });
    } finally { store.close(); }
  }
  const textScore = average(evaluations.map((item) => item.text.score));
  const opticalScore = average(evaluations.map((item) => item.optical.score));
  const textBill = sumBills(evaluations.map((item) => item.text.fullBill));
  const opticalBill = sumBills(evaluations.map((item) => item.optical.fullBill));
  const authoritativeAccounting = evaluations.every((item) => item.text.fullBill.usageReported && item.optical.fullBill.usageReported);
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(), sourceCommit: currentCommit(),
    evaluationType: "paired-model-quality-cost", testId: "BD-050-REGRESSION",
    provider: {
      route: "local-hermes-openai-compatible", baseUrl, model: modelId, credential: "non-empty-placeholder-only",
      standardApiPricing,
    },
    pxpipe: { version: PXPIPE_EVALUATED_VERSION, commit: PXPIPE_EVALUATED_COMMIT },
    policy: "measurement-only-disabled-by-default",
    evaluations,
    aggregate: {
      textQuality: textScore, opticalQuality: opticalScore, qualityDelta: opticalScore - textScore,
      textFullBill: textBill, opticalFullBill: opticalBill,
      authoritativeAccounting, promotionEligible: false,
      inputTokensIncludeProviderBilledImageTokens: authoritativeAccounting,
      conclusion: !authoritativeAccounting
        ? "Hermes returned no authoritative usage fields; quality is measured, but savings and production promotion are prohibited."
        : opticalScore >= textScore
          ? "Optical quality was non-inferior on this bounded benchmark; production remains disabled pending repeated workload evidence."
          : "Optical quality regressed on this bounded benchmark; keep the feature disabled.",
    },
  };
}

async function runEvaluationTurn(
  adapter: OpenAICompatibleProvider,
  model: ModelDescriptor,
  apiKey: string,
  messages: readonly ModelMessage[],
): Promise<{ answer: string; latencyMilliseconds: number; fullBill: Bill }> {
  const started = performance.now();
  let answer = "";
  let usage: Extract<ModelEvent, { type: "usage" }> | undefined;
  for await (const event of adapter.stream({
    model, messages, credential: { authorizationHeader: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(120_000),
  })) {
    if (event.type === "text.delta") answer += event.delta;
    if (event.type === "usage") usage = event;
  }
  const inputRate = optionalRate("LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION");
  const outputRate = optionalRate("LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION");
  const noPerTokenCharge = inputRate === 0 && outputRate === 0;
  return {
    answer: answer.trim(), latencyMilliseconds: performance.now() - started,
    fullBill: {
      usageReported: Boolean(usage), requestBytes: Buffer.byteLength(JSON.stringify(messages)),
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
      cachedInputTokens: usage?.cachedInputTokens ?? null,
      costUsd: usage
        ? (usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1_000_000
        : noPerTokenCharge ? 0 : null,
      accountingNote: usage
        ? "Provider-reported usage; image tokens are included in total input tokens."
        : "Hermes supplied no usage fields; token counts are unknown and no savings claim is permitted.",
    },
  };
}

interface Bill {
  usageReported: boolean; requestBytes: number; inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens: number | null; costUsd: number | null; accountingNote: string;
}

function scoredRun(run: { answer: string; latencyMilliseconds: number; fullBill: Bill }, expected: string) {
  return { ...run, score: normalize(run.answer) === normalize(expected) ? 1 : 0 };
}

function benchmarkTasks(): Array<{ id: string; reference: string; question: string; expected: string }> {
  const filler = Array.from({ length: 34 }, (_, index) =>
    `Operational note ${String(index + 1).padStart(2, "0")}: Gateway authenticates public requests while Manager owns credentials, leases, and execution state.`,
  ).join("\n");
  return [
    {
      id: "recovery-token", expected: "LH-RECOVER-7Q4M",
      reference: `${filler}\nThe immutable recovery token for workspace cold restore is LH-RECOVER-7Q4M.\n${filler}`,
      question: "What is the immutable recovery token for workspace cold restore?",
    },
    {
      id: "fencing-token", expected: "FENCE-2049-ZETA",
      reference: `${filler}\nThe sole accepted fencing token for attempt takeover is FENCE-2049-ZETA. Older tokens must fail closed.\n${filler}`,
      question: "What is the sole accepted fencing token for attempt takeover?",
    },
  ];
}

function sumBills(bills: Bill[]): Bill {
  const usageReported = bills.every((bill) => bill.usageReported);
  return {
    usageReported, requestBytes: bills.reduce((total, bill) => total + bill.requestBytes, 0),
    inputTokens: usageReported ? bills.reduce((total, bill) => total + (bill.inputTokens ?? 0), 0) : null,
    outputTokens: usageReported ? bills.reduce((total, bill) => total + (bill.outputTokens ?? 0), 0) : null,
    cachedInputTokens: usageReported ? bills.reduce((total, bill) => total + (bill.cachedInputTokens ?? 0), 0) : null,
    costUsd: bills.every((bill) => bill.costUsd !== null) ? bills.reduce((total, bill) => total + (bill.costUsd ?? 0), 0) : null,
    accountingNote: usageReported
      ? "Provider-reported aggregate usage."
      : "At least one response omitted usage; aggregate token counts are intentionally null.",
  };
}

function average(values: number[]): number { return values.reduce((total, value) => total + value, 0) / values.length; }
function normalize(value: string): string { return value.trim().replace(/^['"`]|['"`]$/g, "").toUpperCase(); }
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name}`); return value;
}
function optionalRate(name: string): number {
  const value = Number.parseFloat(process.env[name] ?? "0"); return Number.isFinite(value) && value >= 0 ? value : 0;
}
function currentCommit(): string {
  return process.env.GITHUB_SHA?.trim() || process.env.LITE_HARNESS_SOURCE_COMMIT?.trim() ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
