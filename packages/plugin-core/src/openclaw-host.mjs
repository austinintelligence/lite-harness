import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

let implementation;
let initialized = false;

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
    if (typeof implementation?.initialize === "function") {
      await implementation.initialize({ config: params.config, grants: params.grants, manifest: params.manifest });
    }
    initialized = true;
    return { initialized: true, abi: 1 };
  }
  if (!initialized) throw new Error("plugin_not_initialized");
  if (method === "health") return typeof implementation?.health === "function" ? await implementation.health() : { ok: true };
  if (method === "invoke") {
    if (typeof implementation?.invoke === "function") return await implementation.invoke(params.action, params.input);
    const action = implementation?.[params.action];
    if (typeof action !== "function") throw new Error("plugin_action_not_supported");
    return await action.call(implementation, params.input);
  }
  if (method === "migrate") {
    if (typeof implementation?.migrate !== "function") return { migrated: false, reason: "not_supported" };
    return await implementation.migrate(params.from, params.to);
  }
  if (method === "shutdown") {
    if (typeof implementation?.shutdown === "function") await implementation.shutdown(params);
    setImmediate(() => process.exit(0));
    return { stopped: true };
  }
  throw new Error("method_not_supported");
}

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, "[REDACTED]").slice(0, 1024);
}
