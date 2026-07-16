import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureProductionOptionalSystems } from "../apps/manager/src/optional-systems.js";
import { AgentRunner } from "@lite-harness/agent-runtime";
import type { ModelMessage } from "@lite-harness/provider-core";
import { BrokeredToolRuntime, InMemoryToolRuntime } from "@lite-harness/runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("production optional-system composition", () => {
  it("creates no optional tools or resources when every pack is disabled", async () => {
    const root = temporaryRoot();
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const systems = await configureProductionOptionalSystems({ dataDir: root, modelId: "model", runtime, environment: {} });
    expect(runtime.listTools().map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
    expect(systems.context).toBeUndefined();
    await systems.stop();
  });

  it("BD-050-REGRESSION keeps context optimization off by default and retains native text", async () => {
    const root = temporaryRoot();
    const exact = `${"Default-off semantic reference line.\n".repeat(80)}Recovery token: DEFAULT-OFF-42`;
    const contextPath = join(root, "default-off.md");
    writeFileSync(contextPath, exact);
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const systems = await configureProductionOptionalSystems({
      dataDir: root, modelId: "vision-model", runtime,
      environment: {
        LITE_HARNESS_CONTEXT_FILE: contextPath,
        LITE_HARNESS_CONTEXT_KIND: "memory",
        LITE_HARNESS_CONTEXT_ALLOWED_APPS: "app",
        LITE_HARNESS_CONTEXT_ALLOWED_MODELS: "vision-model",
      },
    });
    const messages = await systems.context?.compile({
      input: "read the reference", workspaceId: "workspace", modelId: "vision-model",
      modelCapabilities: ["text", "vision"],
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] },
    });
    expect(messages).toEqual([{ role: "system", content: exact }]);
    await systems.stop();
  });

  it("BD-038-REGRESSION freezes context and skills and composes lazy MCP and owner-scoped caches", async () => {
    const root = temporaryRoot();
    const contextPath = join(root, "operator.md");
    writeFileSync(contextPath, "Keep responses exact.\n");
    const skillRoot = join(root, "skills");
    mkdirSync(join(skillRoot, "review"), { recursive: true });
    writeFileSync(join(skillRoot, "review", "SKILL.md"), "---\nname: review\ndescription: Review carefully\ntools: read_file\n---\nExact review steps.\n");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const systems = await configureProductionOptionalSystems({
      dataDir: root, modelId: "model-a", runtime,
      environment: {
        LITE_HARNESS_CONTEXT_FILE: contextPath,
        LITE_HARNESS_CONTEXT_OPTIMIZATION: "false",
        LITE_HARNESS_SKILL_ROOTS: JSON.stringify([{ root: skillRoot, precedence: 10, source: "app", visibilityScope: "tenant:tenant-a" }]),
        LITE_HARNESS_MCP_SERVERS: JSON.stringify([{
          transport: "stdio", id: "demo", image: `sha256:${"d".repeat(64)}`, command: "does-not-start-during-configuration",
          tools: [{ name: "lookup", inputSchema: { type: "object", additionalProperties: false } }],
        }]),
        LITE_HARNESS_ENABLE_CACHE_CATALOG: "true",
      },
    });
    expect(runtime.listTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "skill_list", "skill_view", "mcp_demo_lookup", "cache_resolve",
    ]));
    await expect(runtime.execute({
      ...execution("mcp_demo_lookup", {}, { appId: "app", tenantId: "tenant-a", userId: "user", scopes: [] }),
      allowedTools: [],
    })).rejects.toThrow(/not advertised to this run/);
    expect(await systems.context?.compile({ input: "hello", workspaceId: "wsp" })).toEqual([
      { role: "system", content: "Keep responses exact.\n" },
    ]);
    const observed: ModelMessage[][] = [];
    const model = { streamTurn: async function* (params: { messages: readonly ModelMessage[] }) {
      observed.push(params.messages.map((message) => ({ ...message })));
      yield { type: "completed" as const, finishReason: "stop" as const };
    } };
    await new AgentRunner(model, runtime, 1, systems.context).run({
      input: "hello", workspaceId: "wsp", allowedTools: [], onEvent: () => undefined,
    });
    expect(observed[0]).toEqual([
      { role: "system", content: "Keep responses exact.\n" },
      { role: "user", content: "hello" },
    ]);
    const principal = { appId: "app", tenantId: "tenant-a", userId: "user", scopes: ["runs:create"] };
    const runGatedSkills = await runtime.execute({
      ...execution("skill_list", {}, principal), runId: "run-gated", allowedTools: ["skill_list", "skill_view"],
    });
    expect(JSON.parse(runGatedSkills.content)).toEqual([]);
    const listedSkills = await runtime.execute(execution("skill_list", {}, principal));
    expect(listedSkills.content).not.toContain("Exact review steps.");
    const otherTenantSkills = await runtime.execute({
      ...execution("skill_list", {}, { ...principal, tenantId: "tenant-b" }), runId: "run-other-tenant",
    });
    expect(JSON.parse(otherTenantSkills.content)).toEqual([]);
    writeFileSync(join(skillRoot, "review", "SKILL.md"), "---\nname: review\ndescription: changed\n---\nTampered.\n");
    const viewed = await runtime.execute(execution("skill_view", { name: "review" }, principal));
    expect(viewed).toMatchObject({
      ok: true, content: "Exact review steps.\n",
      metadata: { requestedTools: ["read_file"], contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/), generation: expect.any(String) },
    });
    const descriptor = {
      class: "workspace-private", kind: "package-store", logicalKey: "pnpm/store", sourceDigest: "c".repeat(64),
      imageDigest: `sha256:${"a".repeat(64)}`, lockDigest: "b".repeat(64), toolVersions: { node: "24.14.0" },
      frameworkVersions: {}, runtimeVersion: "lite-runtime-v1", operatingSystem: "linux", architecture: "amd64",
      configDigest: "d".repeat(64), policyVersion: 1,
    };
    const first = await runtime.execute(execution("cache_resolve", descriptor, principal));
    const second = await runtime.execute(execution("cache_resolve", descriptor, { ...principal, tenantId: "tenant-b" }));
    expect(JSON.parse(first.content).key).not.toBe(JSON.parse(second.content).key);
    expect(first.content).not.toContain(root);
    await systems.stop();
  });

  it("connects an explicitly classified semantic file to the selected vision route and exact recovery", async () => {
    const root = temporaryRoot();
    const exact = `${"Archived semantic reference line.\n".repeat(80)}Recovery token: MANAGER-OPTICAL-42`;
    const contextPath = join(root, "reference.md"); writeFileSync(contextPath, exact);
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const systems = await configureProductionOptionalSystems({
      dataDir: root, modelId: "vision-model", runtime,
      environment: {
        LITE_HARNESS_CONTEXT_FILE: contextPath, LITE_HARNESS_CONTEXT_KIND: "memory",
        LITE_HARNESS_CONTEXT_OPTIMIZATION: "true", LITE_HARNESS_CONTEXT_ALLOWED_APPS: "app",
        LITE_HARNESS_CONTEXT_ALLOWED_MODELS: "vision-model",
      },
    });
    const observed: ModelMessage[][] = [];
    const model = {
      prepareRun: async () => ({
        routePlanId: "route-vision", modelId: "vision-model", providerId: "fixture",
        capabilities: ["text" as const, "vision" as const],
      }),
      streamTurn: async function* (params: { messages: readonly ModelMessage[] }) {
        observed.push(params.messages.map((message) => ({ ...message })));
        yield { type: "completed" as const, finishReason: "stop" as const };
      },
    };
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["runs:create"] };
    await new AgentRunner(model, runtime, 1, systems.context).run({
      input: "read the reference", workspaceId: "workspace", runId: "run", attemptId: "attempt",
      fencingToken: 1, principal, allowedTools: [], onEvent: () => undefined,
    });
    expect(observed[0]?.[0]).toMatchObject({
      role: "user", content: expect.stringContaining("Exact canonical text is retained"),
      imageDataUrls: [expect.stringMatching(/^data:image\/png;base64,/)],
    });
    const blockId = `operator-${createHash("sha256").update(exact).digest("hex")}`;
    const recovered = await runtime.execute({
      ...execution("context_fetch_exact", { blockId }, principal), allowedTools: ["context_fetch_exact"],
    });
    expect(recovered).toMatchObject({ ok: true, content: exact, metadata: { blockId, exact: true } });
    await systems.stop();
  });
});

function execution(name: string, args: Record<string, unknown>, principal: { appId: string; tenantId: string; userId: string; scopes: string[] }) {
  return { workspaceId: "workspace", runId: "run", attemptId: "attempt", principal, call: { id: `call_${name}`, name, arguments: args } };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lite-optional-"));
  roots.push(root);
  return root;
}
