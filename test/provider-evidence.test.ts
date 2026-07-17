import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateWorkflowStructure } from "../scripts/check-workflows.mjs";
import { candidateEvidenceProducer, requiredExternalGateAuthorities } from "../scripts/assemble-ci-evidence.mjs";
import {
  isAuthenticationFailure,
  isCancellationFailure,
  providerLiveEvidencePaths,
  providerLiveGateNames,
  providerLiveGates,
  validateProviderLiveInvocation,
} from "../scripts/evidence-provider.js";

describe("external provider evidence producer", () => {
  it("declares the three owner-controlled provider authorities with a distinct scope", () => {
    expect(providerLiveGateNames).toEqual(["openaiLive", "anthropicLive", "codexLive"]);
    for (const gate of providerLiveGateNames) {
      expect(providerLiveGates[gate as keyof typeof providerLiveGates]).toBeDefined();
      expect(requiredExternalGateAuthorities[gate].scope).toBe("external-provider");
      expect(requiredExternalGateAuthorities[gate].ciJob).toBe("provider-live-evidence");
      expect(requiredExternalGateAuthorities[gate].producer).toBe(`pnpm evidence:provider --gate ${gate}`);
      expect(providerLiveEvidencePaths[gate as keyof typeof providerLiveEvidencePaths]).toBe(requiredExternalGateAuthorities[gate].path);
      expect(candidateEvidenceProducer(requiredExternalGateAuthorities[gate].path)).toMatchObject({
        ciJob: "provider-live-evidence",
        producer: `pnpm evidence:provider --gate ${gate}`,
        kind: "policy-check",
        suite: `external-${gate}`,
      });
    }
  });

  it("refuses live provider evidence outside GitHub Actions", () => {
    expect(validateProviderLiveInvocation("openaiLive", { GITHUB_ACTIONS: undefined })).toContainEqual(
      expect.stringContaining("Provider live evidence is CI-only"),
    );
    expect(validateProviderLiveInvocation("unknown", { GITHUB_ACTIONS: "true" })[0]).toContain("--gate must be one of");
  });

  it("only accepts a semantically authenticated negative response", () => {
    expect(isAuthenticationFailure({ status: 401 })).toBe(true);
    expect(isAuthenticationFailure({ code: "authentication_failed" })).toBe(true);
    expect(isAuthenticationFailure({ code: "process_failed", message: "login required" })).toBe(true);
    expect(isAuthenticationFailure({ code: "process_failed", message: "connection refused" })).toBe(false);
    expect(isAuthenticationFailure({ status: 500 })).toBe(false);
  });

  it("only accepts cancellation after an abort-shaped failure", () => {
    const aborted = AbortSignal.abort(new DOMException("cancelled", "AbortError"));
    expect(isCancellationFailure(new DOMException("The operation was aborted", "AbortError"), aborted)).toBe(true);
    expect(isCancellationFailure({ code: "provider_unavailable", status: 503 }, aborted)).toBe(false);
    expect(isCancellationFailure(new Error("connection reset"), aborted)).toBe(false);
    expect(isCancellationFailure(new DOMException("The operation was aborted", "AbortError"), new AbortController().signal)).toBe(false);
  });

  it("writes a redacted fail envelope when CI prerequisites are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "lite-provider-evidence-test-"));
    const evidence = join(root, "openai-live.json");
    try {
      const result = await runNode([
        "--import", "tsx", "scripts/evidence-provider.ts",
        "--gate", "openaiLive", "--evidence", evidence,
      ], {
        GITHUB_ACTIONS: "true",
        GITHUB_WORKFLOW: "External provider evidence",
        GITHUB_JOB: "provider-live-evidence",
        GITHUB_RUN_ID: "synthetic",
        GITHUB_RUN_ATTEMPT: "1",
        LITE_HARNESS_OPENAI_MODEL: undefined,
        LITE_HARNESS_OPENAI_API_KEY: undefined,
        LITE_HARNESS_PROVIDER_INPUT_USD_PER_MILLION: undefined,
        LITE_HARNESS_PROVIDER_OUTPUT_USD_PER_MILLION: undefined,
      });
      expect(result.status).toBe(1);
      const document = JSON.parse(await readFile(evidence, "utf8")) as Record<string, any>;
      expect(document.subject.scope).toBe("external-provider");
      expect(document.test.result).toBe("fail");
      expect(document.externalGates.openaiLive).toBe("fail");
      expect(document.test.counts.skipped).toBe(0);
      expect(document.test.cases).toHaveLength(6);
      expect(JSON.stringify(document)).not.toMatch(/Bearer\s+[A-Za-z0-9._~+\/-]{20,}/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("wires the protected provider workflow and CI fan-in", () => {
    const workflow = readFileSync(resolve(".github/workflows/external-provider-evidence.yml"), "utf8");
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.scripts["evidence:provider"]).toBe("tsx scripts/evidence-provider.ts");
    expect(validateWorkflowStructure(workflow, "external-provider-evidence.yml")).toEqual([]);
    expect(workflow).toContain("environment: provider-live");
    expect(workflow).toContain("runs-on: [self-hosted, provider-live]");
    expect(workflow).toContain("LITE_HARNESS_OPENAI_API_KEY");
    expect(workflow).toContain("LITE_HARNESS_ANTHROPIC_API_KEY");
    expect(workflow).toContain("pnpm evidence:provider --gate");
    expect(workflow).toContain("evidencePath: evidence/external/openai-live.json");
    expect(workflow).toContain("--evidence ${{ matrix.evidencePath }}");
    expect(ci).toContain("external_provider_gate");
    expect(ci).toContain("uses: ./.github/workflows/external-provider-evidence.yml");
    expect(ci).toContain("secrets: inherit");
  });
});

function runNode(args: string[], overrides: Record<string, string | undefined>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}
