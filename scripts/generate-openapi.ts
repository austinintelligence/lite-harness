import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CreateAgentProfileRequestSchema,
  CreateRunRequestSchema,
  CreateWorkspaceRequestSchema,
  RunBudgetOverridesSchema,
} from "@lite-harness/contracts";

const root = resolve(import.meta.dirname, "..");
const path = resolve(root, "docs", "openapi.json");
const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
document["x-lite-generated-from-contracts"] = {
  source: "packages/contracts/src/index.ts",
  version: 1,
};
document.components.schemas.CreateRun = clone(CreateRunRequestSchema);
document.components.schemas.RunBudgetOverrides = clone(RunBudgetOverridesSchema);
document.components.schemas.CreateAgent = clone(CreateAgentProfileRequestSchema);
document.components.schemas.CreateWorkspace = clone(CreateWorkspaceRequestSchema);

const gateway = readFileSync(resolve(root, "apps", "gateway", "src", "server.ts"), "utf8");
const publicRoutes = new Set(
  [...gateway.matchAll(/["`](\/(?:healthz|readyz|hooks|v1)[^"`]*)["`]/g)]
    .map((match) => match[1] as string)
    .filter((route) => !route.includes("${") && route !== "/hooks/")
    .map((route) => route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}")),
);
const missing = [...publicRoutes].filter((route) => !(route in document.paths));
if (missing.length) throw new Error(`OpenAPI is missing public Gateway routes: ${missing.join(", ")}`);

const content = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8").replaceAll("\r\n", "\n") !== content) {
    process.stderr.write("OpenAPI is stale; run pnpm generate:openapi.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`OpenAPI contract check passed for ${Object.keys(document.paths).length} paths.\n`);
  }
} else {
  writeFileSync(path, content);
  process.stdout.write(`Generated OpenAPI from authoritative contracts with ${Object.keys(document.paths).length} paths.\n`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
