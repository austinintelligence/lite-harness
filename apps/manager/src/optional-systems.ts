import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentContextCompiler } from "@lite-harness/agent-runtime";
import {
  ConservativeContextCompiler,
  ContextOptimizationGate,
  ContextStore,
  OptionalPxpipeRenderer,
  TenantContextRenderCache,
} from "@lite-harness/context";
import type { InternalPrincipal, ToolDefinition } from "@lite-harness/contracts";
import { McpSupervisor, StdioMcpTransport, StreamableHttpMcpTransport } from "@lite-harness/mcp";
import {
  createOpenClawCompatibilityWorker,
  DockerPluginExecutionSandbox,
  inspectPluginManifest,
  LazyPluginSupervisor,
  PluginInstallLock,
  pluginPackageDigest,
} from "@lite-harness/plugin-core";
import type { BrokeredToolRuntime } from "@lite-harness/runtime";
import type { DockerToolRuntime } from "@lite-harness/runtime-docker";
import { discoverSkills, type SkillSnapshot, type SkillSource } from "@lite-harness/skills";
import {
  LocalCacheCatalog,
  LocalWorkspaceSnapshotStore,
  SnapshotCompactorQueue,
  StaticSnapshotKeyProvider,
} from "@lite-harness/workspace";

interface OptionalSystemsOptions {
  dataDir: string;
  modelId: string;
  runtime: BrokeredToolRuntime;
  dockerRuntime?: DockerToolRuntime;
  snapshotKey?: Buffer;
  environment?: NodeJS.ProcessEnv;
}

export interface ProductionOptionalSystems {
  context?: AgentContextCompiler;
  stop(): Promise<void>;
}

/** Composes optional packs without starting a worker, timer, socket, or Docker job. */
export function configureProductionOptionalSystems(options: OptionalSystemsOptions): ProductionOptionalSystems {
  const environment = options.environment ?? process.env;
  const stops: Array<() => Promise<void>> = [];
  const context = configureContext(options.dataDir, options.modelId, environment);
  configureSkills(options.runtime, environment);
  const mcp = configureMcp(options.runtime, environment);
  if (mcp) stops.push(() => mcp.stopAll());
  const plugins = configurePlugins(options.runtime, options.dataDir, environment);
  if (plugins.length) stops.push(() => Promise.all(plugins.map((plugin) => plugin.stop())).then(() => undefined));
  configureSnapshots(options, environment);
  configureCacheCatalog(options.runtime, options.dataDir, environment);
  return {
    ...(context ? { context } : {}),
    stop: async () => { for (const stop of stops.reverse()) await stop(); },
  };
}

function configureContext(dataDir: string, modelId: string, environment: NodeJS.ProcessEnv): AgentContextCompiler | undefined {
  const contextFile = environment.LITE_HARNESS_CONTEXT_FILE?.trim();
  if (!contextFile) return undefined;
  const path = resolve(contextFile);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("LITE_HARNESS_CONTEXT_FILE must be a file no larger than 1 MiB");
  const exactText = readFileSync(path, "utf8");
  const store = new ContextStore();
  store.put({ id: `operator-${createHash("sha256").update(exactText).digest("hex")}`, kind: "instructions", exactText, lossyEligible: true, sensitive: false });
  const enabled = environment.LITE_HARNESS_CONTEXT_OPTIMIZATION === "true";
  const allowedApps = csvSet(environment.LITE_HARNESS_CONTEXT_ALLOWED_APPS);
  const allowedModels = csvSet(environment.LITE_HARNESS_CONTEXT_ALLOWED_MODELS);
  const gate = new ContextOptimizationGate({ enabled, allowedApps, allowedModels });
  const compiler = new ConservativeContextCompiler(
    store,
    new OptionalPxpipeRenderer(),
    allowedModels,
    { gate, cache: new TenantContextRenderCache() },
  );
  return {
    compile: async ({ principal }) => {
      const blocks = await compiler.compile(
        modelId,
        enabled ? "conservative" : "off",
        principal ? { appId: principal.appId, tenantId: principal.tenantId } : undefined,
      );
      // Provider-core is text-canonical today. Keep exact text authoritative if
      // an optional renderer produced a view the selected adapter cannot encode.
      return blocks.map((block) => ({
        role: "system" as const,
        content: block.representation === "text" ? String(block.content) : store.fetchExact(block.id),
      }));
    },
  };
}

function configureSkills(runtime: BrokeredToolRuntime, environment: NodeJS.ProcessEnv): void {
  const raw = environment.LITE_HARNESS_SKILL_ROOTS?.trim();
  if (!raw) return;
  const sources = parseJson(raw, "LITE_HARNESS_SKILL_ROOTS") as unknown;
  if (!Array.isArray(sources)) throw new Error("LITE_HARNESS_SKILL_ROOTS must be a JSON array");
  const normalized = sources.map(validateSkillSource);
  const skills = Object.freeze(discoverSkills(normalized).map((skill) => Object.freeze({ ...skill })));
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  runtime.register("skill_list", async (params) => ({
    callId: params.call.id, ok: true,
    content: JSON.stringify(skills.map(({ name, description, source, precedence, requestedTools }) => ({ name, description, source, precedence, requestedTools }))),
    metadata: { count: skills.length },
  }), toolDefinition("List the immutable skills available to this Manager generation.", { type: "object", additionalProperties: false }));
  runtime.register("skill_view", async (params) => {
    const name = requiredString(params.call.arguments.name, "name");
    const skill = byName.get(name);
    if (!skill) return { callId: params.call.id, ok: false, content: `Skill not found: ${name}` };
    return { callId: params.call.id, ok: true, content: skill.body, metadata: skillMetadata(skill) };
  }, toolDefinition("Load one exact immutable skill body. Skill metadata never grants tools.", {
    type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 256 } }, required: ["name"], additionalProperties: false,
  }));
}

function configureMcp(runtime: BrokeredToolRuntime, environment: NodeJS.ProcessEnv): McpSupervisor | undefined {
  const raw = environment.LITE_HARNESS_MCP_SERVERS?.trim();
  if (!raw) return undefined;
  const entries = parseJson(raw, "LITE_HARNESS_MCP_SERVERS") as unknown;
  if (!Array.isArray(entries)) throw new Error("LITE_HARNESS_MCP_SERVERS must be a JSON array");
  const supervisor = new McpSupervisor();
  for (const value of entries) {
    const server = objectRecord(value, "MCP server");
    const id = identifier(server.id, "MCP server id");
    const tools = validateAdvertisedTools(server.tools, `MCP server ${id}`);
    const include = optionalStringArray(server.include, "MCP include");
    const exclude = optionalStringArray(server.exclude, "MCP exclude");
    if (server.transport === "stdio") {
      const command = requiredString(server.command, "MCP command");
      const args = optionalStringArray(server.args, "MCP args") ?? [];
      const cwd = server.cwd === undefined ? undefined : resolve(requiredString(server.cwd, "MCP cwd"));
      const inheritEnv = optionalStringArray(server.inheritEnv, "MCP inherited environment") ?? [];
      supervisor.register(id, () => new StdioMcpTransport({ command, args, ...(cwd ? { cwd } : {}), inheritEnv }), { include, exclude });
    } else if (server.transport === "http") {
      const url = requiredString(server.url, "MCP URL");
      const allowedOrigins = optionalStringArray(server.allowedOrigins, "MCP allowed origins") ?? [];
      const authorizationEnvironment = server.authorizationEnvironment === undefined
        ? undefined : environmentName(server.authorizationEnvironment, "MCP authorization environment");
      supervisor.register(id, () => new StreamableHttpMcpTransport({
        url, allowedOrigins,
        ...(authorizationEnvironment ? { authorization: async () => environment[authorizationEnvironment] } : {}),
      }), { include, exclude });
    } else {
      throw new Error(`MCP server ${id} transport must be stdio or http`);
    }
    for (const tool of tools) {
      const publicName = tool.alias ?? `mcp_${id}_${tool.name}`.replace(/[^a-z0-9_]/g, "_");
      runtime.register(publicName, async (params) => ({
        callId: params.call.id, ok: true,
        content: JSON.stringify(await supervisor.call(id, tool.name, params.call.arguments)),
        metadata: { serverId: id, tool: tool.name },
      }), toolDefinition(tool.description ?? `Invoke MCP tool ${id}.${tool.name}.`, tool.inputSchema));
    }
  }
  return supervisor;
}

function configurePlugins(runtime: BrokeredToolRuntime, dataDir: string, environment: NodeJS.ProcessEnv): LazyPluginSupervisor[] {
  if (environment.LITE_HARNESS_ENABLE_PLUGINS !== "true") return [];
  const image = requiredString(environment.LITE_HARNESS_PLUGIN_IMAGE, "LITE_HARNESS_PLUGIN_IMAGE");
  const pluginRoot = join(dataDir, "plugins");
  const lock = new PluginInstallLock(join(dataDir, "plugins.lock.json"));
  const sandbox = new DockerPluginExecutionSandbox({ image });
  const supervisors: LazyPluginSupervisor[] = [];
  for (const entry of Object.values(lock.read().plugins).filter((item) => item.enabled)) {
    if (entry.trust === "data-only") continue;
    const inspected = inspectPluginManifest(join(pluginRoot, entry.id, entry.version, "lite-plugin.json"));
    if (pluginPackageDigest(inspected) !== entry.digest) throw new Error(`Enabled plugin digest mismatch: ${entry.id}@${entry.version}`);
    const supervisor = new LazyPluginSupervisor(() => createOpenClawCompatibilityWorker(
      inspected, entry.grantedPermissions, {}, { sandbox },
    ));
    supervisors.push(supervisor);
    for (const tool of entry.grantedPermissions.tools) {
      runtime.register(tool, async (params) => ({
        callId: params.call.id, ok: true,
        content: JSON.stringify(await supervisor.invoke(tool, params.call.arguments)),
        metadata: { pluginId: entry.id, pluginVersion: entry.version },
      }));
    }
  }
  return supervisors;
}

function configureSnapshots(options: OptionalSystemsOptions, environment: NodeJS.ProcessEnv): void {
  if (environment.LITE_HARNESS_ENABLE_SNAPSHOT_COMPACTION !== "true") return;
  if (!options.dockerRuntime || !options.snapshotKey) throw new Error("Snapshot compaction requires Docker runtime and a snapshot key");
  const snapshotRoot = join(options.dataDir, "snapshots");
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const contexts = new Map<string, { workspaceId: string; principal: InternalPrincipal; signal?: AbortSignal }>();
  const store = new LocalWorkspaceSnapshotStore(snapshotRoot, new StaticSnapshotKeyProvider(options.snapshotKey));
  const queue = new SnapshotCompactorQueue(snapshotRoot, async (identity) => {
    const current = contexts.get(identity);
    if (!current) throw new Error("Snapshot ownership context expired");
    const archive = await options.dockerRuntime!.exportWorkspace(current.workspaceId, current.principal, current.signal);
    return store.create(identity, archive);
  });
  options.runtime.register("workspace_snapshot", async (params) => {
    const principal = requirePrincipal(params.principal);
    const identity = ownedWorkspaceIdentity(params.workspaceId, principal);
    contexts.set(identity, { workspaceId: params.workspaceId, principal, ...(params.signal ? { signal: params.signal } : {}) });
    try {
      const record = await queue.enqueue(identity);
      return { callId: params.call.id, ok: true, content: JSON.stringify({ sha256: record.sha256, plaintextBytes: record.plaintextBytes, createdAt: record.createdAt }) };
    } finally { contexts.delete(identity); }
  }, toolDefinition("Create an authenticated encrypted snapshot of the current owned Docker workspace.", { type: "object", additionalProperties: false }));
}

function configureCacheCatalog(runtime: BrokeredToolRuntime, dataDir: string, environment: NodeJS.ProcessEnv): void {
  if (environment.LITE_HARNESS_ENABLE_CACHE_CATALOG !== "true") return;
  const catalog = new LocalCacheCatalog(join(dataDir, "caches"));
  runtime.register("cache_resolve", async (params) => {
    const principal = requirePrincipal(params.principal);
    const kind = requiredString(params.call.arguments.class, "class");
    if (!(["global-immutable", "tenant-private", "workspace-private"] as const).includes(kind as never)) throw new Error("Cache class is invalid");
    const descriptor = {
      class: kind as "global-immutable" | "tenant-private" | "workspace-private",
      logicalKey: requiredString(params.call.arguments.logicalKey, "logicalKey"),
      imageDigest: requiredString(params.call.arguments.imageDigest, "imageDigest"),
      toolchain: requiredString(params.call.arguments.toolchain, "toolchain"),
      lockDigest: requiredString(params.call.arguments.lockDigest, "lockDigest"),
      ...(kind === "global-immutable" ? {} : { tenantId: principal.tenantId }),
      ...(kind === "workspace-private" ? { workspaceId: params.workspaceId } : {}),
    };
    const resolved = catalog.resolve(descriptor);
    return { callId: params.call.id, ok: true, content: JSON.stringify({ key: resolved.key, class: resolved.class }), metadata: { cacheKey: resolved.key } };
  }, toolDefinition("Resolve an owner-scoped cache generation. Host paths are never disclosed.", {
    type: "object",
    properties: {
      class: { enum: ["global-immutable", "tenant-private", "workspace-private"] },
      logicalKey: { type: "string" }, imageDigest: { type: "string" }, toolchain: { type: "string" }, lockDigest: { type: "string" },
    },
    required: ["class", "logicalKey", "imageDigest", "toolchain", "lockDigest"], additionalProperties: false,
  }));
}

function validateSkillSource(value: unknown): SkillSource {
  const source = objectRecord(value, "skill source");
  const kind = requiredString(source.source, "skill source kind");
  if (!(["app", "user", "builtin", "openclaw-import"] as const).includes(kind as never)) throw new Error("Skill source kind is invalid");
  if (!Number.isSafeInteger(source.precedence)) throw new Error("Skill source precedence must be an integer");
  return { root: resolve(requiredString(source.root, "skill root")), precedence: source.precedence as number, source: kind as SkillSource["source"] };
}

function validateAdvertisedTools(value: unknown, label: string): Array<{ name: string; alias?: string; description?: string; inputSchema: Record<string, unknown> }> {
  if (!Array.isArray(value)) throw new Error(`${label} tools must be an array`);
  return value.map((entry) => {
    const tool = objectRecord(entry, `${label} tool`);
    const inputSchema = objectRecord(tool.inputSchema, `${label} tool schema`);
    return {
      name: requiredString(tool.name, `${label} tool name`),
      ...(tool.alias === undefined ? {} : { alias: identifier(tool.alias, `${label} tool alias`) }),
      ...(tool.description === undefined ? {} : { description: requiredString(tool.description, `${label} tool description`) }),
      inputSchema,
    };
  });
}

function toolDefinition(description: string, inputSchema: Record<string, unknown>): Omit<ToolDefinition, "name"> { return { description, inputSchema }; }
function skillMetadata(skill: SkillSnapshot): Record<string, unknown> { return { name: skill.name, source: skill.source, precedence: skill.precedence, requestedTools: skill.requestedTools }; }
function csvSet(value: string | undefined): Set<string> { return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean)); }
function parseJson(value: string, label: string): unknown { try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); } }
function objectRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function requiredString(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a bounded single-line string`); return value.trim(); }
function identifier(value: unknown, label: string): string { const text = requiredString(value, label); if (!/^[a-z][a-z0-9_]{0,63}$/.test(text)) throw new Error(`${label} must be a lowercase identifier`); return text; }
function environmentName(value: unknown, label: string): string { const text = requiredString(value, label); if (!/^LITE_HARNESS_[A-Z0-9_]+$/.test(text)) throw new Error(`${label} must name a LITE_HARNESS_ variable`); return text; }
function optionalStringArray(value: unknown, label: string): string[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0 && item.length < 4096 && !/[\0\r\n]/.test(item))) throw new Error(`${label} must be an array of bounded strings`); return [...value]; }
function requirePrincipal(value: InternalPrincipal | undefined): InternalPrincipal { if (!value) throw new Error("Optional Manager capability requires an owned run principal"); return value; }
function ownedWorkspaceIdentity(workspaceId: string, principal: InternalPrincipal): string { return `owned-${createHash("sha256").update(JSON.stringify([principal.appId, principal.tenantId, principal.userId, workspaceId])).digest("hex")}`; }
