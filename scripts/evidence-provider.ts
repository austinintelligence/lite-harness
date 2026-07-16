import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  captureFacts,
  createEvidenceDocument,
  missingExternalGates,
  sanitizeDiagnosticText,
  writeEvidenceFile,
} from "./evidence-lib.mjs";
import {
  CapabilityBoundModelGateway,
  InMemoryCredentialBroker,
  ModelRegistry,
  OFFICIAL_OPENAI_MODEL_PROFILES,
  RoutedModelGateway,
  type ModelDescriptor,
  type ModelEvent,
  type ModelMessage,
} from "@lite-harness/provider-core";
import { AnthropicProvider } from "@lite-harness/provider-anthropic";
import { OpenAIResponsesProvider } from "@lite-harness/provider-openai-compatible";
import { CodexAppServerGateway } from "@lite-harness/delegated-runtime";

const root = resolve(import.meta.dirname, "..");

export const providerLiveGates = Object.freeze({
  openaiLive: Object.freeze({
    providerId: "openai",
    modelEnv: "LITE_HARNESS_OPENAI_MODEL",
    keyEnv: "LITE_HARNESS_OPENAI_API_KEY",
  }),
  anthropicLive: Object.freeze({
    providerId: "anthropic",
    modelEnv: "LITE_HARNESS_ANTHROPIC_MODEL",
    keyEnv: "LITE_HARNESS_ANTHROPIC_API_KEY",
  }),
  codexLive: Object.freeze({
    providerId: "codex",
    modelEnv: "LITE_HARNESS_CODEX_MODEL",
    keyEnv: null,
  }),
});

export const providerLiveGateNames = Object.freeze(Object.keys(providerLiveGates));

export const providerLiveEvidencePaths = Object.freeze({
  openaiLive: "evidence/external/openai-live.json",
  anthropicLive: "evidence/external/anthropic-live.json",
  codexLive: "evidence/external/codex-live.json",
});

const scenarioNames = Object.freeze([
  "sharedAutomatedConformance",
  "liveTextStream",
  "liveToolCall",
  "liveCancellation",
  "liveAuthError",
  "liveUsageAndCost",
]);

const scenarioTestIds = Object.freeze({
  sharedAutomatedConformance: "A16-SHARED-PROVIDER-CONFORMANCE",
  liveTextStream: "A16-LIVE-TEXT-STREAM",
  liveToolCall: "A16-LIVE-TOOL-CALL",
  liveCancellation: "A16-LIVE-CANCELLATION",
  liveAuthError: "A16-LIVE-AUTH-ERROR",
  liveUsageAndCost: "A16-LIVE-USAGE-COST",
});

interface ScenarioResult {
  passed: boolean;
  detail?: string;
}

interface ProviderSession {
  stream(messages: readonly ModelMessage[], tools?: readonly ToolDefinitionLike[], signal?: AbortSignal): AsyncIterable<ModelEvent>;
  dispose(): Promise<void>;
}

interface ToolDefinitionLike {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ProviderEvidenceResult {
  gate: string;
  result: "pass" | "fail";
  assertions: Record<string, boolean>;
  scenarios: Record<string, ScenarioResult>;
  failures: string[];
}

/**
 * Provider evidence is deliberately CI-only. The workflow uses a protected
 * environment and operator-owned credentials; a local shell must never turn
 * this command into an accidental billable or credential-bearing request.
 */
export function validateProviderLiveInvocation(gate: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const failures: string[] = [];
  if (!gate || !Object.hasOwn(providerLiveGates, gate)) failures.push(`--gate must be one of: ${providerLiveGateNames.join(", ")}`);
  if (env.GITHUB_ACTIONS !== "true") failures.push("Provider live evidence is CI-only; run the protected provider-live workflow");
  if (env.GITHUB_ACTIONS === "true") {
    for (const name of ["GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
      if (!env[name]?.trim()) failures.push(`${name} is required for provider evidence authority`);
    }
  }
  return failures;
}

/**
 * A negative credential scenario must prove an authentication boundary, not
 * merely observe that some unrelated network/process error occurred. Keep the
 * predicate intentionally narrow because the evidence is release-authority
 * material.
 */
export function isAuthenticationFailure(error: unknown): boolean {
  const record = asErrorRecord(error);
  if (record.status === 401 || record.status === 403) return true;
  const descriptor = `${record.code ?? ""} ${record.name ?? ""} ${record.message ?? ""}`;
  return /(?:authentication[_ -]?failed|auth(?:entication)?[_ -]?(?:required|failed|error)|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?key|credential)|credential[_ -]?(?:invalid|missing|expired)|not[_ -]?authenticated|login[_ -]?required|sign[_ -]?in[_ -]?required)/i.test(descriptor);
}

/**
 * Cancellation evidence must identify an abort/cancel path after the signal
 * fired; a provider 5xx, timeout, or malformed response is not cancellation.
 */
export function isCancellationFailure(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const record = asErrorRecord(error);
  const code = `${record.code ?? ""} ${record.name ?? ""}`;
  const message = record.message ?? "";
  return record.name === "AbortError" || /(?:abort(?:ed|ing)?|cancel(?:led|ed)?)/i.test(code) ||
    /(?:abort(?:ed|ing)?|cancel(?:led|ed)?)/i.test(message);
}

export async function runProviderEvidence(gate: string, output: string): Promise<ProviderEvidenceResult> {
  const spec = providerLiveGates[gate as keyof typeof providerLiveGates];
  if (!spec) throw new Error(`Unsupported provider live gate: ${gate}`);
  const startedAt = Date.now();
  const facts = captureFacts(root);
  const failures: string[] = [];
  const scenarios: Record<string, ScenarioResult> = {};

  const shared = runSharedConformance();
  scenarios.sharedAutomatedConformance = shared;

  const modelId = process.env[spec.modelEnv]?.trim() ?? "";
  if (!modelId) failures.push(`${spec.modelEnv} is missing`);
  const pricing = resolvePricing(spec.providerId, modelId);
  if (!pricing) failures.push("provider model pricing is missing; set both provider price variables or use a frozen OpenAI model profile");

  const workspace = mkdtempSync(join(resolve(process.env.RUNNER_TEMP ?? process.env.TEMP ?? root), "lite-provider-live-"));
  try {
    if (!modelId || !pricing) {
      for (const name of scenarioNames.filter((item) => item !== "sharedAutomatedConformance")) {
        scenarios[name] = { passed: false, detail: "prerequisite-missing" };
      }
    } else {
      let session: ProviderSession | undefined;
      try {
        session = await createProviderSession(spec.providerId, modelId, pricing, workspace);
        scenarios.liveTextStream = await scenarioTextStream(session);
        scenarios.liveToolCall = await scenarioToolCall(spec.providerId, session, workspace);
        scenarios.liveCancellation = await scenarioCancellation(session);
        scenarios.liveAuthError = await scenarioAuthError(spec.providerId, modelId, pricing, workspace);
        scenarios.liveUsageAndCost = await scenarioUsageAndCost(session);
      } catch (error) {
        const detail = safeErrorCode(error);
        failures.push(`provider session failed: ${detail}`);
        for (const name of scenarioNames.filter((item) => item !== "sharedAutomatedConformance")) {
          scenarios[name] ??= { passed: false, detail };
        }
      } finally {
        await session?.dispose();
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  for (const name of scenarioNames) {
    const scenario = scenarios[name];
    if (!scenario?.passed) failures.push(`${name} did not pass`);
  }
  const assertions = Object.fromEntries(scenarioNames.map((name) => [name, scenarios[name]?.passed === true]));
  const result = Object.values(assertions).every(Boolean) ? "pass" : "fail";
  const externalGates = { ...missingExternalGates, [gate]: result };
  const cases = scenarioNames.map((name) => ({
    path: "scripts/evidence-provider.ts",
    name: scenarioTestIds[name as keyof typeof scenarioTestIds],
    status: assertions[name] ? "passed" as const : "failed" as const,
  }));
  const document = createEvidenceDocument({
    root,
    kind: "policy-check",
    scope: "external-provider",
    suite: `external-${gate}`,
    command: `pnpm evidence:provider --gate ${gate}`,
    result,
    counts: {
      total: cases.length,
      passed: cases.filter((item) => item.status === "passed").length,
      failed: cases.filter((item) => item.status === "failed").length,
      skipped: 0,
      todo: 0,
    },
    durationMs: Date.now() - startedAt,
    cases,
    requirementIds: ["A16"],
    regressionIds: ["BD-030-REGRESSION", "BD-031-REGRESSION", "BD-032-REGRESSION", "BD-033-REGRESSION", "BD-039-REGRESSION"],
    claims: {
      assertions,
      policyProof: {
        sourcePath: "scripts/evidence-provider.ts",
        caseBindings: Object.fromEntries(scenarioNames.map((name) => [scenarioTestIds[name as keyof typeof scenarioTestIds], [name]])),
      },
      provider: {
        gate,
        providerId: spec.providerId,
        model: modelId || "<missing>",
        liveRedacted: true,
        sharedAutomatedCoverage: ["streams", "tools", "cancellation", "auth-refresh", "usage-cost", "rate-error", "malformed", "retry-safety"],
        liveCoverage: ["text-stream", "tool-call", "cancellation", "invalid-credential", "usage-cost"],
        scenarioResults: Object.fromEntries(Object.entries(scenarios).map(([name, value]) => [name, {
          passed: value.passed,
          ...(value.detail ? { detail: sanitizeDiagnosticText(value.detail, { maxBytes: 256 }) } : {}),
        }])),
      },
      failures: failures.map((failure) => sanitizeDiagnosticText(failure, { maxBytes: 512 })),
    },
    attachments: [],
    externalGates,
    facts,
  });
  writeEvidenceFile(resolve(root, output), document);
  return { gate, result, assertions, scenarios, failures };
}

async function createProviderSession(
  providerId: string,
  modelId: string,
  pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number },
  workspace: string,
): Promise<ProviderSession> {
  const descriptor: ModelDescriptor = {
    id: modelId,
    providerId,
    transport: providerId === "codex" ? "delegated" : "direct",
    credentialProfileId: "provider-live",
    capabilities: ["text", "tools", ...(providerId === "codex" ? ["delegated-agent" as const] : [])],
    contextWindow: 128_000,
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    provenance: "operator",
    enabled: true,
  };
  const context = () => ({
    runId: `provider-live-${randomUUID()}`,
    attemptId: `attempt-${randomUUID()}`,
    workspaceId: "provider-live-workspace",
    principal: { appId: "provider-live", tenantId: "provider-live", userId: "provider-live", scopes: [] },
    fencingToken: 1,
    maxCostUsd: 10,
    requiredCapabilities: ["text" as const],
  });

  if (providerId === "codex") {
    const inner = new CodexAppServerGateway({
      command: process.env.LITE_HARNESS_CODEX_COMMAND?.trim() || "codex",
      model: modelId,
      codexHome: process.env.LITE_HARNESS_CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim(),
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
      timeoutMs: 120_000,
      workspacePathForRun: () => workspace,
      approve: async () => "accept",
    });
    const gateway = new CapabilityBoundModelGateway(descriptor, inner);
    return {
      stream: (messages, tools, signal) => gateway.streamTurn({
        messages,
        ...(tools?.length ? { tools } : {}),
        signal,
        context: context(),
      }),
      dispose: async () => undefined,
    };
  }

  const keyEnv = providerLiveGates[providerId === "openai" ? "openaiLive" : "anthropicLive"].keyEnv;
  const key = keyEnv ? process.env[keyEnv]?.trim() : undefined;
  if (!key) throw new Error("credential_missing");
  const credentials = new InMemoryCredentialBroker();
  credentials.set("provider-live", { authorizationHeader: `Bearer ${key}` });
  const registry = new ModelRegistry([descriptor]);
  const route = registry.plan({ requiredCapabilities: ["text"] });
  const adapter = providerId === "openai" ? new OpenAIResponsesProvider() : new AnthropicProvider();
  const gateway = new RoutedModelGateway(route, [adapter], credentials);
  return {
    stream: (messages, tools, signal) => gateway.streamTurn({
      messages,
      ...(tools?.length ? { tools } : {}),
      signal,
      context: context(),
    }),
    dispose: async () => undefined,
  };
}

async function scenarioTextStream(session: ProviderSession): Promise<ScenarioResult> {
  try {
    const events = await collect(session.stream([
      { role: "user", content: "Reply with exactly LITE_HARNESS_PROVIDER_TEXT_OK and no other words." },
    ]));
    const text = events.filter((event): event is Extract<ModelEvent, { type: "text.delta" }> => event.type === "text.delta")
      .map((event) => event.delta).join("");
    const completed = events.some((event) => event.type === "completed" && event.finishReason === "stop");
    return { passed: text.includes("LITE_HARNESS_PROVIDER_TEXT_OK") && completed };
  } catch (error) {
    return { passed: false, detail: safeErrorCode(error) };
  }
}

async function scenarioToolCall(providerId: string, session: ProviderSession, workspace: string): Promise<ScenarioResult> {
  try {
    if (providerId === "codex") {
      const marker = "LITE_HARNESS_CODEX_TOOL_OK";
      const markerPath = join(workspace, "provider-tool-marker.txt");
      const events = await collect(session.stream([
        { role: "user", content: `Use the shell tool to write exactly ${marker} to provider-tool-marker.txt in the current workspace, then reply with exactly ${marker}. Do not skip the tool.` },
      ]));
      const text = events.filter((event): event is Extract<ModelEvent, { type: "text.delta" }> => event.type === "text.delta")
        .map((event) => event.delta).join("");
      return { passed: existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === marker && text.includes(marker) };
    }
    const tool = {
      name: "record_marker",
      description: "Record the supplied marker for the conformance test.",
      inputSchema: {
        type: "object",
        properties: { marker: { type: "string", const: "LITE_HARNESS_TOOL_OK" } },
        required: ["marker"],
        additionalProperties: false,
      },
    };
    const events = await collect(session.stream([
      { role: "user", content: "You must call record_marker exactly once with marker LITE_HARNESS_TOOL_OK. Do not answer until you have made the tool call." },
    ], [tool]));
    return { passed: events.some((event) => event.type === "tool.call" && event.call.name === "record_marker" && event.call.arguments.marker === "LITE_HARNESS_TOOL_OK") };
  } catch (error) {
    return { passed: false, detail: safeErrorCode(error) };
  }
}

async function scenarioCancellation(session: ProviderSession): Promise<ScenarioResult> {
  const controller = new AbortController();
  const iterator = session.stream([
    { role: "user", content: `Return a long answer. ${"Please continue describing the conformance cancellation boundary. ".repeat(1_000)}` },
  ], undefined, controller.signal)[Symbol.asyncIterator]();
  const timer = setTimeout(() => controller.abort(new DOMException("provider live cancellation", "AbortError")), 50);
  timer.unref?.();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) return { passed: false, detail: "completed-before-cancellation" };
    }
  } catch (error) {
    const cancelled = isCancellationFailure(error, controller.signal);
    return { passed: cancelled, detail: cancelled ? undefined : safeErrorCode(error) };
  } finally {
    clearTimeout(timer);
    await iterator.return?.().catch(() => undefined);
  }
}

async function scenarioAuthError(providerId: string, modelId: string, pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number }, workspace: string): Promise<ScenarioResult> {
  if (providerId === "codex") {
    const isolatedHome = mkdtempSync(join(workspace, "codex-no-auth-"));
    try {
      const inner = new CodexAppServerGateway({
        command: process.env.LITE_HARNESS_CODEX_COMMAND?.trim() || "codex",
        model: modelId,
        codexHome: isolatedHome,
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        outputUsdPerMillion: pricing.outputUsdPerMillion,
        timeoutMs: 15_000,
        workspacePathForRun: () => workspace,
        approve: async () => "decline",
      });
      const iterator = inner.streamTurn({
        messages: [{ role: "user", content: "Reply with exactly LITE_HARNESS_AUTH_NEGATIVE_OK." }],
        context: {
          runId: `auth-${randomUUID()}`, attemptId: `attempt-${randomUUID()}`, workspaceId: "provider-live-workspace",
          principal: { appId: "provider-live", tenantId: "provider-live", userId: "provider-live", scopes: [] }, fencingToken: 1,
        },
      })[Symbol.asyncIterator]();
      while (true) {
        const next = await iterator.next();
        if (next.done) return { passed: false, detail: "isolated-codex-home-authenticated" };
      }
    } catch (error) {
      return { passed: isAuthenticationFailure(error), detail: safeErrorCode(error) };
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }
  const keyEnv = providerLiveGates[providerId === "openai" ? "openaiLive" : "anthropicLive"].keyEnv;
  const credentials = new InMemoryCredentialBroker();
  credentials.set("provider-live-negative", { authorizationHeader: "Bearer invalid-live-conformance-token" });
  const descriptor: ModelDescriptor = {
    id: modelId,
    providerId,
    transport: "direct",
    credentialProfileId: "provider-live-negative",
    capabilities: ["text", "tools"],
    contextWindow: 128_000,
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    provenance: "operator",
    enabled: true,
  };
  const adapter = providerId === "openai" ? new OpenAIResponsesProvider() : new AnthropicProvider();
  const gateway = new RoutedModelGateway(new ModelRegistry([descriptor]).plan({ requiredCapabilities: ["text"] }), [adapter], credentials);
  try {
    for await (const _event of gateway.streamTurn({ messages: [{ role: "user", content: "Reply with exactly LITE_HARNESS_AUTH_NEGATIVE_OK." }] })) {
      // A successful response means the negative credential was unexpectedly accepted.
    }
    return { passed: false, detail: `${keyEnv ?? "provider"}-accepted-invalid-credential` };
  } catch (error) {
    return { passed: isAuthenticationFailure(error), detail: safeErrorCode(error) };
  }
}

async function scenarioUsageAndCost(session: ProviderSession): Promise<ScenarioResult> {
  try {
    const events = await collect(session.stream([{ role: "user", content: "Reply with exactly LITE_HARNESS_USAGE_OK." }]));
    const usage = events.find((event): event is Extract<ModelEvent, { type: "usage" }> => event.type === "usage");
    return {
      passed: Boolean(usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 &&
        Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 &&
        usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0),
      ...(usage ? {} : { detail: "usage-event-missing" }),
    };
  } catch (error) {
    return { passed: false, detail: safeErrorCode(error) };
  }
}

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function runSharedConformance(): ScenarioResult {
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["test:providers"], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
    timeout: 180_000,
    env: {
      ...process.env,
      LITE_HARNESS_LIVE_MODEL_TEST: undefined,
      LITE_HARNESS_OPENAI_API_KEY: undefined,
      LITE_HARNESS_ANTHROPIC_API_KEY: undefined,
    },
  });
  return result.status === 0 ? { passed: true } : { passed: false, detail: "shared-conformance-failed" };
}

function resolvePricing(providerId: string, modelId: string): { inputUsdPerMillion: number; outputUsdPerMillion: number } | undefined {
  const input = numberEnv("LITE_HARNESS_PROVIDER_INPUT_USD_PER_MILLION");
  const output = numberEnv("LITE_HARNESS_PROVIDER_OUTPUT_USD_PER_MILLION");
  if (input !== undefined && output !== undefined) return { inputUsdPerMillion: input, outputUsdPerMillion: output };
  if (providerId === "openai") {
    const profile = OFFICIAL_OPENAI_MODEL_PROFILES[modelId.toLowerCase()];
    if (profile) return { inputUsdPerMillion: profile.inputUsdPerMillion, outputUsdPerMillion: profile.outputUsdPerMillion };
  }
  return undefined;
}

function numberEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function safeErrorCode(error: unknown): string {
  const value = asErrorRecord(error);
  if (value.code) return value.code.slice(0, 128);
  if (value.name) return value.name.slice(0, 128);
  if (value.status !== undefined) return `http-${value.status}`;
  return "provider-live-error";
}

function asErrorRecord(error: unknown): {
  code?: string;
  name?: string;
  message?: string;
  status?: number;
} {
  if (!error || typeof error !== "object") return {};
  const value = error as { code?: unknown; name?: unknown; message?: unknown; status?: unknown };
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const gate = option("--gate");
  const output = option("--evidence") ?? providerLiveEvidencePaths[gate as keyof typeof providerLiveEvidencePaths] ?? "evidence/external/provider.json";
  const invocationFailures = validateProviderLiveInvocation(gate);
  if (invocationFailures.length) throw new Error(invocationFailures.join("; "));
  const result = await runProviderEvidence(gate as string, output);
  process.stdout.write(`Provider ${gate} evidence written (${result.result}).\n`);
  if (result.result !== "pass") process.exitCode = 1;
}
