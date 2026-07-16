import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

let implementation;
let initialized = false;
let manifest;
let compatibilityState;
const compatibilityTools = new Map();
const compatibilityServices = [];
let compatibilityGrantedTools = [];

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => void handle(line));

async function handle(line) {
  let request;
  try {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("request_too_large");
    request = JSON.parse(line);
    const result = await dispatch(request.method, request.params ?? {});
    respond({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    respond({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32000, message: safeMessage(error) } });
  }
}

async function dispatch(method, params) {
  if (method === "initialize") {
    if (initialized) return { initialized: true };
    const entry = process.env.LITE_PLUGIN_ENTRY;
    if (!entry || entry.includes("\0")) throw new Error("plugin_entry_missing");
    const module = await import(pathToFileURL(resolve(process.cwd(), entry)).href);
    implementation = module.default ?? module.plugin ?? module;
    manifest = params.manifest;
    if (manifest?.trust === "openclaw-compat") {
      if (typeof implementation?.register !== "function") throw new Error("compat_register_required");
      compatibilityGrantedTools = Array.isArray(params.grants?.tools) ? [...params.grants.tools] : [];
      compatibilityState = immutableJsonValue(params.config?.state ?? {});
      await implementation.register(
        openClawCompatibilityApi(params.grants),
        Object.freeze({ state: compatibilityState }),
      );
      for (const name of compatibilityGrantedTools) {
        if (!compatibilityTools.has(name)) throw new Error(`compat_tool_not_registered:${name}`);
      }
      for (const service of compatibilityServices) await service.start?.();
    } else if (typeof implementation?.initialize === "function") {
      await implementation.initialize({ config: params.config, grants: params.grants, manifest: params.manifest });
    }
    initialized = true;
    return { initialized: true, abi: 1 };
  }
  if (!initialized) throw new Error("plugin_not_initialized");
  if (method === "health") {
    if (typeof implementation?.health === "function") assertHealthy(await implementation.health());
    for (const service of compatibilityServices) assertHealthy(await service.health?.());
    return { ok: true };
  }
  if (method === "invoke") {
    const compatibilityTool = compatibilityTools.get(params.action);
    if (compatibilityTool) return await compatibilityTool(params.input);
    if (typeof implementation?.invoke === "function") return await implementation.invoke(params.action, params.input);
    const action = implementation?.[params.action];
    if (typeof action !== "function") throw new Error("plugin_action_not_supported");
    return await action.call(implementation, params.input);
  }
  if (method === "migrate") {
    if (typeof implementation?.migrate !== "function") return { migrated: false, reason: "not_supported" };
    return await implementation.migrate(
      params.from,
      params.to,
      Object.freeze({ state: compatibilityState }),
    );
  }
  if (method === "shutdown") {
    for (const service of [...compatibilityServices].reverse()) await service.stop?.();
    if (typeof implementation?.shutdown === "function") await implementation.shutdown(params);
    setImmediate(() => process.exit(0));
    return { stopped: true };
  }
  throw new Error("method_not_supported");
}

function assertHealthy(result) {
  if (result && typeof result === "object" && result.ok === false) throw new Error("plugin_health_reported_unhealthy");
}

function immutableJsonValue(value) {
  const cloned = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(cloned);
}

function openClawCompatibilityApi(grants) {
  const grantedTools = new Set(Array.isArray(grants?.tools) ? grants.tools : []);
  return Object.freeze({
    registerTool(definition) {
      if (!definition || typeof definition !== "object") throw new Error("compat_tool_definition_invalid");
      const name = definition.name;
      if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(name)) throw new Error("compat_tool_name_invalid");
      if (!grantedTools.has(name) || !manifest?.permissions?.tools?.includes(name)) throw new Error(`compat_tool_not_granted:${name}`);
      if (compatibilityTools.has(name)) throw new Error(`compat_tool_duplicate:${name}`);
      const execute = typeof definition.execute === "function" ? definition.execute : definition.handler;
      if (typeof execute !== "function") throw new Error(`compat_tool_handler_missing:${name}`);
      compatibilityTools.set(name, (input) => execute(input));
    },
    registerService(service) {
      if (!service || typeof service !== "object") throw new Error("compat_service_definition_invalid");
      for (const operation of ["start", "health", "stop"]) {
        if (service[operation] !== undefined && typeof service[operation] !== "function") {
          throw new Error(`compat_service_${operation}_invalid`);
        }
      }
      compatibilityServices.push(service);
    },
  });
}

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, "[REDACTED]").slice(0, 1024);
}
