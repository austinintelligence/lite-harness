import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentContextCompiler } from "@lite-harness/agent-runtime";
import { parseBooleanEnvironment } from "@lite-harness/config";
import { isLoopbackHttpUrl, LITE_IPC_PROTOCOL_VERSION, type InternalPrincipal, type ToolDefinition } from "@lite-harness/contracts";
import type { McpSupervisor } from "@lite-harness/mcp";
import type { LazyPluginSupervisor } from "@lite-harness/plugin-core";
import type { BrokeredToolRuntime } from "@lite-harness/runtime";
import type { DockerToolRuntime } from "@lite-harness/runtime-docker";
import type { ImmutableSkillSnapshot, SkillSource } from "@lite-harness/skills";
import {
  LocalCacheCatalog,
  LocalWorkspaceSnapshotStore,
  ManagedWorkspaceLifecycle,
  StaticSnapshotKeyProvider,
  type WorkspaceLifecycleStore,
} from "@lite-harness/workspace";

interface OptionalSystemsOptions {
  dataDir: string;
  modelId: string;
  runtime: BrokeredToolRuntime;
  dockerRuntime?: DockerToolRuntime;
  workspaceStore?: WorkspaceLifecycleStore;
  snapshotKey?: Buffer;
  environment?: NodeJS.ProcessEnv;
  offline?: boolean;
  featureFlags?: {
    contextOptimization: boolean;
    plugins: boolean;
    cacheCatalog: boolean;
  };
}

export interface ProductionOptionalSystems {
  context?: AgentContextCompiler;
  workspaceLifecycle?: ManagedWorkspaceLifecycle;
  plugins: Array<{ id: string; version: string; digest: string }>;
  stop(): Promise<void>;
}

/** Composes optional packs without starting a worker, timer, socket, or Docker job. */
export async function configureProductionOptionalSystems(options: OptionalSystemsOptions): Promise<ProductionOptionalSystems> {
  const environment = options.environment ?? process.env;
  const featureFlags = options.featureFlags ?? {
    contextOptimization: parseBooleanEnvironment(environment.LITE_HARNESS_CONTEXT_OPTIMIZATION, "LITE_HARNESS_CONTEXT_OPTIMIZATION"),
    plugins: parseBooleanEnvironment(environment.LITE_HARNESS_ENABLE_PLUGINS, "LITE_HARNESS_ENABLE_PLUGINS"),
    cacheCatalog: parseBooleanEnvironment(environment.LITE_HARNESS_ENABLE_CACHE_CATALOG, "LITE_HARNESS_ENABLE_CACHE_CATALOG"),
  };
  const offline = options.offline ?? parseBooleanEnvironment(environment.LITE_HARNESS_OFFLINE, "LITE_HARNESS_OFFLINE");
  const stops: Array<() => Promise<void>> = [];
  const contextCompilers: AgentContextCompiler[] = [];
  const operatorContext = await configureContext(options.runtime, options.dataDir, options.modelId, environment, featureFlags.contextOptimization);
  if (operatorContext) { contextCompilers.push(operatorContext.context); stops.push(operatorContext.stop); }
  const skills = await configureSkills(options.runtime, options.dataDir, environment);
  if (skills) { contextCompilers.push(skills.context); stops.push(skills.stop); }
  const mcp = await configureMcp(options.runtime, environment, offline);
  if (mcp) stops.push(() => mcp.stopAll());
  const plugins = await configurePlugins(options.runtime, options.dataDir, environment, featureFlags.plugins);
  if (plugins.supervisors.length) stops.push(async () => {
    const results = await Promise.allSettled(plugins.supervisors.map((plugin) => plugin.stop()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "One or more plugin supervisors failed to stop");
  });
  const workspaceLifecycle = configureSnapshots(options);
  configureCacheCatalog(options.runtime, options.dataDir, featureFlags.cacheCatalog);
  const context = contextCompilers.length ? composeContextCompilers(contextCompilers) : undefined;
  return {
    ...(context ? { context } : {}),
    ...(workspaceLifecycle ? { workspaceLifecycle } : {}),
    plugins: plugins.snapshots,
    stop: async () => {
      const failures: unknown[] = [];
      for (const stop of [...stops].reverse()) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, "One or more optional systems failed to stop");
    },
  };
}

async function configureContext(runtime: BrokeredToolRuntime, dataDir: string, modelId: string, environment: NodeJS.ProcessEnv, enabled: boolean): Promise<{
  context: AgentContextCompiler;
  stop(): Promise<void>;
} | undefined> {
  const contextFile = environment.LITE_HARNESS_CONTEXT_FILE?.trim();
  if (!contextFile) return undefined;
  const { ConservativeContextCompiler, ContextOptimizationGate, ContextStore, OptionalPxpipeRenderer, TenantContextRenderCache } = await import("@lite-harness/context");
  const path = resolve(contextFile);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("LITE_HARNESS_CONTEXT_FILE must be a file no larger than 1 MiB");
  const exactText = readFileSync(path, "utf8");
  mkdirSync(dataDir, { recursive: true });
  const store = new ContextStore(join(dataDir, "context.sqlite"));
  const kind = environment.LITE_HARNESS_CONTEXT_KIND?.trim() || "instructions";
  if (!(["instructions", "source", "logs", "memory"] as const).includes(kind as "instructions")) {
    store.close();
    throw new Error("LITE_HARNESS_CONTEXT_KIND must be instructions, source, logs, or memory");
  }
  const lossyEligible = kind === "logs" || kind === "memory";
  store.put({
    id: `operator-${createHash("sha256").update(exactText).digest("hex")}`,
    kind: kind as "instructions" | "source" | "logs" | "memory", exactText, lossyEligible, sensitive: false,
    provenance: `operator:${basename(path)}`, timeRange: { start: metadata.mtime.toISOString(), end: metadata.mtime.toISOString() },
  });
  runtime.register("context_fetch_exact", async (params) => {
    const blockId = requiredString(params.call.arguments.blockId, "context block id");
    const content = store.fetchExact(blockId);
    return { callId: params.call.id, ok: true, content, metadata: { blockId, exact: true } };
  }, {
    description: "Fetch the exact canonical text for an optical context block by stable ID.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["blockId"],
      properties: { blockId: { type: "string", minLength: 1, maxLength: 256 } },
    },
  });
  const allowedApps = csvSet(environment.LITE_HARNESS_CONTEXT_ALLOWED_APPS);
  const allowedModels = csvSet(environment.LITE_HARNESS_CONTEXT_ALLOWED_MODELS);
  const killedApps = csvSet(environment.LITE_HARNESS_CONTEXT_KILLED_APPS);
  const killedModels = csvSet(environment.LITE_HARNESS_CONTEXT_KILLED_MODELS);
  const gate = new ContextOptimizationGate({ enabled, allowedApps, allowedModels, killedApps, killedModels });
  const compiler = new ConservativeContextCompiler(
    store,
    new OptionalPxpipeRenderer(),
    allowedModels,
    { gate, cache: new TenantContextRenderCache() },
  );
  const context: AgentContextCompiler = {
    compile: async ({ principal, modelId: selectedModelId, modelCapabilities }) => {
      const blocks = await compiler.compile(
        selectedModelId ?? modelId,
        enabled ? "conservative" : "off",
        principal ? { appId: principal.appId, tenantId: principal.tenantId, modelCapabilities } : undefined,
      );
      return blocks.map((block) => ({
        role: block.representation === "text" ? "system" as const : "user" as const,
        content: block.nativeLabel,
        ...(block.representation === "image" ? { imageDataUrls: block.content as readonly string[] } : {}),
      }));
    },
  };
  return { context, stop: async () => { store.close(); } };
}

async function configureSkills(runtime: BrokeredToolRuntime, dataDir: string, environment: NodeJS.ProcessEnv): Promise<{
  context: AgentContextCompiler;
  stop(): Promise<void>;
} | undefined> {
  const raw = environment.LITE_HARNESS_SKILL_ROOTS?.trim();
  if (!raw) return undefined;
  const { DurableSkillRunSnapshotStore, ImmutableSkillCatalog } = await import("@lite-harness/skills");
  const sources = parseJson(raw, "LITE_HARNESS_SKILL_ROOTS") as unknown;
  if (!Array.isArray(sources)) throw new Error("LITE_HARNESS_SKILL_ROOTS must be a JSON array");
  const normalized = sources.map(validateSkillSource);
  const catalog = new ImmutableSkillCatalog(normalized, {
    snapshotRoot: join(dataDir, "skill-snapshots"),
    protocolVersion: LITE_IPC_PROTOCOL_VERSION,
  });
  const snapshots = new DurableSkillRunSnapshotStore(join(dataDir, "skill-run-snapshots.sqlite"));
  const eligibility = (params: { principal?: InternalPrincipal; workspaceId: string; runId?: string; allowedTools?: readonly string[] }) => {
    const principal = requirePrincipal(params.principal);
    const runId = requiredString(params.runId, "run id");
    return {
      allowedTools: new Set(params.allowedTools ?? runtime.listTools().map((tool) => tool.name)),
      capabilities: csvSet(environment.LITE_HARNESS_SKILL_CAPABILITIES),
      protocolVersion: LITE_IPC_PROTOCOL_VERSION,
      visibilityScopes: new Set([
        "public", `app:${principal.appId}`, `tenant:${principal.tenantId}`, `user:${principal.userId}`,
        `workspace:${params.workspaceId}`, `run:${runId}`,
      ]),
    };
  };
  runtime.register("skill_list", async (params) => {
    const runSnapshot = recordRunSnapshot(params);
    const skills = catalog.list(eligibility(params));
    return {
      callId: params.call.id, ok: true, content: JSON.stringify(skills),
      metadata: { count: skills.length, generation: runSnapshot.generation, digests: runSnapshot.skills },
    };
  }, toolDefinition("List bounded eligible immutable skill manifests without loading instruction bodies.", { type: "object", additionalProperties: false }));
  runtime.register("skill_view", async (params) => {
    const name = requiredString(params.call.arguments.name, "name");
    const runSnapshot = recordRunSnapshot(params);
    const skill = catalog.view(name, eligibility(params));
    if (!skill) return { callId: params.call.id, ok: false, content: `Skill not found: ${name}` };
    return { callId: params.call.id, ok: true, content: skill.body, metadata: skillMetadata(skill, runSnapshot.runId) };
  }, toolDefinition("Load one exact immutable skill body. Skill metadata never grants tools.", {
    type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 256 } }, required: ["name"], additionalProperties: false,
  }));
  function recordRunSnapshot(params: { principal?: InternalPrincipal; workspaceId: string; runId?: string; allowedTools?: readonly string[] }) {
    const principal = requirePrincipal(params.principal);
    const runSnapshot = catalog.snapshotForRun(requiredString(params.runId, "run id"), eligibility(params));
    snapshots.record({
      runId: runSnapshot.runId, appId: principal.appId, tenantId: principal.tenantId, userId: principal.userId,
      workspaceId: params.workspaceId, generation: runSnapshot.generation, skills: runSnapshot.skills,
    });
    return runSnapshot;
  }
  return {
    context: {
      compile: async (params) => {
        if (params.runId && params.principal) recordRunSnapshot(params);
        return [];
      },
      snapshotForRun: async ({ runId, principal }) => ({ skills: snapshots.get(runId, principal)?.skills.map((skill) => ({ name: skill.name, digest: skill.digest })) ?? [] }),
    },
    stop: async () => snapshots.close(),
  };
}

function composeContextCompilers(compilers: readonly AgentContextCompiler[]): AgentContextCompiler {
  return {
    compile: async (params) => (await Promise.all(compilers.map((compiler) => compiler.compile(params)))).flat(),
    snapshotForRun: async (params) => ({
      skills: (await Promise.all(compilers.map(async (compiler) => (await compiler.snapshotForRun?.(params))?.skills ?? []))).flat(),
    }),
  };
}

async function configureMcp(runtime: BrokeredToolRuntime, environment: NodeJS.ProcessEnv, offline: boolean): Promise<McpSupervisor | undefined> {
  const raw = environment.LITE_HARNESS_MCP_SERVERS?.trim();
  if (!raw) return undefined;
  const { BrokeredMcpToolPolicy, DockerStdioMcpTransport, McpSupervisor, StreamableHttpMcpTransport } = await import("@lite-harness/mcp");
  const entries = parseJson(raw, "LITE_HARNESS_MCP_SERVERS") as unknown;
  if (!Array.isArray(entries)) throw new Error("LITE_HARNESS_MCP_SERVERS must be a JSON array");
  const supervisor = new McpSupervisor();
  for (const value of entries) {
    const server = objectRecord(value, "MCP server");
    const id = identifier(server.id, "MCP server id");
    const tools = validateAdvertisedTools(server.tools, `MCP server ${id}`);
    const include = optionalStringArray(server.include, "MCP include");
    const exclude = optionalStringArray(server.exclude, "MCP exclude");
    const advertisedPolicy = new BrokeredMcpToolPolicy({ include, exclude });
    const advertisedToolNames = new Set(advertisedPolicy.filterTools(tools).map((tool) => tool.name));
    const advertisedTools = tools.filter((tool) => advertisedToolNames.has(tool.name));
    if (server.transport === "stdio") {
      const image = requiredString(server.image, "MCP image");
      if (!image.includes("@sha256:") && !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`MCP server ${id} image must be pinned by sha256 digest`);
      const command = requiredString(server.command, "MCP command");
      const args = optionalStringArray(server.args, "MCP args") ?? [];
      const seccompProfile = server.seccompProfile === undefined ? undefined : resolve(requiredString(server.seccompProfile, "MCP seccomp profile"));
      if (server.cwd !== undefined || server.inheritEnv !== undefined || server.env !== undefined) {
        throw new Error(`MCP server ${id} cannot request host cwd or environment inheritance`);
      }
      supervisor.register(id, () => new DockerStdioMcpTransport({
        image, command, args, ...(seccompProfile ? { seccompProfile } : {}),
      }), { include, exclude, expectedTools: advertisedTools });
    } else if (server.transport === "http") {
      const url = requiredString(server.url, "MCP URL");
      const allowedOrigins = optionalStringArray(server.allowedOrigins, "MCP allowed origins") ?? [];
      let endpointOrigin: string;
      try { endpointOrigin = new URL(url).origin; }
      catch { throw new Error(`MCP server ${id} URL is invalid`); }
      if (!allowedOrigins.includes(endpointOrigin)) throw new Error(`MCP server ${id} endpoint origin must be explicitly allowed`);
      if (offline && (!isLoopbackHttpUrl(url) || allowedOrigins.some((origin) => !isLoopbackHttpUrl(origin)))) {
        throw new Error(`Offline mode requires MCP HTTP server ${id} and every allowed origin to use loopback HTTP(S) URLs`);
      }
      const authorizationEnvironment = server.authorizationEnvironment === undefined
        ? undefined : environmentName(server.authorizationEnvironment, "MCP authorization environment");
      supervisor.register(id, () => new StreamableHttpMcpTransport({
        url, allowedOrigins,
        ...(authorizationEnvironment ? { authorization: async () => environment[authorizationEnvironment] } : {}),
      }), { include, exclude, expectedTools: advertisedTools });
    } else {
      throw new Error(`MCP server ${id} transport must be stdio or http`);
    }
    for (const tool of advertisedTools) {
      const publicName = tool.alias ?? `mcp_${id}_${tool.name}`.replace(/[^a-z0-9_]/g, "_");
      runtime.register(publicName, async (params) => {
        if (!params.allowedTools?.includes(publicName)) throw new Error(`MCP tool was not advertised to this run: ${publicName}`);
        return {
          callId: params.call.id, ok: true,
          content: JSON.stringify(await supervisor.call(id, tool.name, params.call.arguments, params.signal)),
          metadata: { serverId: id, tool: tool.name },
        };
      }, toolDefinition(tool.description ?? `Invoke MCP tool ${id}.${tool.name}.`, tool.inputSchema));
    }
  }
  return supervisor;
}

async function configurePlugins(runtime: BrokeredToolRuntime, dataDir: string, environment: NodeJS.ProcessEnv, enabled: boolean): Promise<{
  supervisors: LazyPluginSupervisor[];
  snapshots: Array<{ id: string; version: string; digest: string }>;
}> {
  if (!enabled) return { supervisors: [], snapshots: [] };
  const { createOpenClawCompatibilityWorker, DockerPluginExecutionSandbox, inspectPluginManifest, LazyPluginSupervisor, PluginInstallLock, pluginPackageDigest } = await import("@lite-harness/plugin-core");
  const image = requiredString(environment.LITE_HARNESS_PLUGIN_IMAGE, "LITE_HARNESS_PLUGIN_IMAGE");
  const pluginRoot = join(dataDir, "plugins");
  const lock = new PluginInstallLock(join(dataDir, "plugins.lock.json"));
  const sandbox = new DockerPluginExecutionSandbox({ image, installationId: dataDir });
  const reapedPluginContainers = await sandbox.reconcileContainers();
  if (reapedPluginContainers > 0) {
    process.stderr.write(`lite-harness manager: reaped ${reapedPluginContainers} interrupted plugin container(s)\n`);
  }
  const supervisors: LazyPluginSupervisor[] = [];
  const snapshots: Array<{ id: string; version: string; digest: string }> = [];
  for (const entry of Object.values(lock.read().plugins).filter((item) => item.enabled)) {
    snapshots.push({ id: entry.id, version: entry.version, digest: entry.digest });
    if (entry.trust === "data-only") continue;
    const inspected = inspectPluginManifest(join(pluginRoot, entry.id, entry.version, "lite-plugin.json"));
    if (pluginPackageDigest(inspected) !== entry.digest) throw new Error(`Enabled plugin digest mismatch: ${entry.id}@${entry.version}`);
    const supervisor = new LazyPluginSupervisor(() => createOpenClawCompatibilityWorker(
      inspected, entry.grantedPermissions, {}, { sandbox },
    ), {
      onCleanupError: () => process.stderr.write(
        `lite-harness manager: plugin cleanup pending retry for ${entry.id}@${entry.version}\n`,
      ),
    });
    supervisors.push(supervisor);
    for (const tool of entry.grantedPermissions.tools) {
      runtime.register(tool, async (params) => ({
        callId: params.call.id, ok: true,
        content: JSON.stringify(await supervisor.invoke(tool, params.call.arguments)),
        metadata: { pluginId: entry.id, pluginVersion: entry.version },
      }));
    }
  }
  return { supervisors, snapshots: snapshots.sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)) };
}

function configureSnapshots(options: OptionalSystemsOptions): ManagedWorkspaceLifecycle | undefined {
  if (!options.dockerRuntime) return undefined;
  if (!options.snapshotKey || !options.workspaceStore) throw new Error("Managed Docker workspaces require a snapshot key and lifecycle store");
  const snapshotRoot = join(options.dataDir, "snapshots");
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const store = new LocalWorkspaceSnapshotStore(snapshotRoot, new StaticSnapshotKeyProvider(options.snapshotKey));
  return new ManagedWorkspaceLifecycle(options.workspaceStore, options.dockerRuntime, store);
}

function configureCacheCatalog(runtime: BrokeredToolRuntime, dataDir: string, enabled: boolean): void {
  if (!enabled) return;
  const catalog = new LocalCacheCatalog(join(dataDir, "caches"));
  runtime.register("cache_resolve", async (params) => {
    const principal = requirePrincipal(params.principal);
    const kind = requiredString(params.call.arguments.class, "class");
    if (!(["global-immutable", "tenant-private", "workspace-private"] as const).includes(kind as never)) throw new Error("Cache class is invalid");
    const descriptor = {
      class: kind as "global-immutable" | "tenant-private" | "workspace-private",
      kind: requiredString(params.call.arguments.kind, "kind"),
      logicalKey: requiredString(params.call.arguments.logicalKey, "logicalKey"),
      sourceDigest: requiredString(params.call.arguments.sourceDigest, "sourceDigest"),
      imageDigest: requiredString(params.call.arguments.imageDigest, "imageDigest"),
      lockDigest: requiredString(params.call.arguments.lockDigest, "lockDigest"),
      toolVersions: stringRecord(params.call.arguments.toolVersions, "toolVersions"),
      frameworkVersions: stringRecord(params.call.arguments.frameworkVersions, "frameworkVersions"),
      runtimeVersion: requiredString(params.call.arguments.runtimeVersion, "runtimeVersion"),
      operatingSystem: requiredString(params.call.arguments.operatingSystem, "operatingSystem"),
      architecture: requiredString(params.call.arguments.architecture, "architecture"),
      configDigest: requiredString(params.call.arguments.configDigest, "configDigest"),
      policyVersion: requiredInteger(params.call.arguments.policyVersion, "policyVersion"),
      ...(kind === "global-immutable" ? {} : { tenantId: principal.tenantId }),
      ...(kind === "workspace-private" ? { workspaceId: params.workspaceId } : {}),
    };
    const resolved = catalog.resolve(descriptor);
    return { callId: params.call.id, ok: true, content: JSON.stringify({ key: resolved.key, class: resolved.class, state: resolved.state }), metadata: { cacheKey: resolved.key } };
  }, toolDefinition("Resolve an owner-scoped cache generation. Host paths are never disclosed.", {
    type: "object",
    properties: {
      class: { enum: ["global-immutable", "tenant-private", "workspace-private"] },
      kind: { type: "string" }, logicalKey: { type: "string" }, sourceDigest: { type: "string" },
      imageDigest: { type: "string" }, lockDigest: { type: "string" },
      toolVersions: { type: "object", additionalProperties: { type: "string" } },
      frameworkVersions: { type: "object", additionalProperties: { type: "string" } },
      runtimeVersion: { type: "string" }, operatingSystem: { type: "string" }, architecture: { type: "string" },
      configDigest: { type: "string" }, policyVersion: { type: "integer", minimum: 1 },
    },
    required: ["class", "kind", "logicalKey", "sourceDigest", "imageDigest", "lockDigest", "toolVersions", "frameworkVersions", "runtimeVersion", "operatingSystem", "architecture", "configDigest", "policyVersion"], additionalProperties: false,
  }));
}

function validateSkillSource(value: unknown): SkillSource {
  const source = objectRecord(value, "skill source");
  const kind = requiredString(source.source, "skill source kind");
  if (!(["run-pinned", "workspace", "app", "user", "installed-pack", "builtin", "openclaw-import"] as const).includes(kind as never)) throw new Error("Skill source kind is invalid");
  if (!Number.isSafeInteger(source.precedence)) throw new Error("Skill source precedence must be an integer");
  const visibilityScope = source.visibilityScope === undefined
    ? (["builtin", "installed-pack"] as const).includes(kind as never) ? "public" : undefined
    : requiredString(source.visibilityScope, "skill visibility scope");
  if (!visibilityScope) throw new Error(`Skill source ${kind} requires an explicit app, tenant, user, workspace, or run visibilityScope`);
  return {
    root: resolve(requiredString(source.root, "skill root")), precedence: source.precedence as number, source: kind as SkillSource["source"],
    ...(source.sourceVersion === undefined ? {} : { sourceVersion: requiredString(source.sourceVersion, "skill source version") }),
    visibilityScope,
  };
}

function validateAdvertisedTools(value: unknown, label: string): Array<{ name: string; alias?: string; description?: string; inputSchema: Record<string, unknown> }> {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} tools must be an array of at most 256 entries`);
  const names = new Set<string>();
  return value.map((entry) => {
    const tool = objectRecord(entry, `${label} tool`);
    const inputSchema = objectRecord(tool.inputSchema, `${label} tool schema`);
    const name = requiredString(tool.name, `${label} tool name`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(name) || names.has(name)) throw new Error(`${label} tool name is invalid or duplicated`);
    const encodedSchema = JSON.stringify(inputSchema);
    if (Buffer.byteLength(encodedSchema) > 1024 * 1024) throw new Error(`${label} tool schema exceeds 1 MiB`);
    names.add(name);
    return {
      name,
      ...(tool.alias === undefined ? {} : { alias: identifier(tool.alias, `${label} tool alias`) }),
      ...(tool.description === undefined ? {} : { description: requiredString(tool.description, `${label} tool description`) }),
      inputSchema,
    };
  });
}

function toolDefinition(description: string, inputSchema: Record<string, unknown>): Omit<ToolDefinition, "name"> { return { description, inputSchema }; }
function skillMetadata(skill: ImmutableSkillSnapshot, runId: string): Record<string, unknown> {
  return {
    runId, name: skill.name, source: skill.source, sourceVersion: skill.sourceVersion,
    precedence: skill.precedence, requestedTools: skill.requestedTools,
    requiredCapabilities: skill.requiredCapabilities, permissionRequests: skill.permissionRequests,
    contentDigest: skill.contentDigest, generation: skill.generation,
  };
}
function csvSet(value: string | undefined): Set<string> { return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean)); }
function parseJson(value: string, label: string): unknown { try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); } }
function objectRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function requiredString(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a bounded single-line string`); return value.trim(); }
function requiredInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`); return value as number; }
function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = objectRecord(value, label);
  if (Object.keys(record).length > 64) throw new Error(`${label} has too many entries`);
  return Object.fromEntries(Object.entries(record).map(([name, entry]) => [name, requiredString(entry, `${label}.${name}`)]));
}
function identifier(value: unknown, label: string): string { const text = requiredString(value, label); if (!/^[a-z][a-z0-9_]{0,63}$/.test(text)) throw new Error(`${label} must be a lowercase identifier`); return text; }
function environmentName(value: unknown, label: string): string { const text = requiredString(value, label); if (!/^LITE_HARNESS_[A-Z0-9_]+$/.test(text)) throw new Error(`${label} must name a LITE_HARNESS_ variable`); return text; }
function optionalStringArray(value: unknown, label: string): string[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0 && item.length < 4096 && !/[\0\r\n]/.test(item))) throw new Error(`${label} must be an array of bounded strings`); return [...value]; }
function requirePrincipal(value: InternalPrincipal | undefined): InternalPrincipal { if (!value) throw new Error("Optional Manager capability requires an owned run principal"); return value; }
