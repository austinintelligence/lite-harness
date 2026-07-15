import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CreateAgentProfileRequestSchema,
  CreateRunRequestSchema,
  CreateWorkspaceRequestSchema,
  ErrorEnvelopeSchema,
  LITE_API_VERSION,
  MintRunTokenRequestSchema,
  MintRunTokenResponseSchema,
  PublishArtifactRequestSchema,
  RevokeTokenResponseSchema,
  RunBudgetOverridesSchema,
} from "@lite-harness/contracts";

const root = resolve(import.meta.dirname, "..");
const path = resolve(root, "docs", "openapi.json");
const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
document["x-lite-generated-from-contracts"] = {
  source: "packages/contracts/src/index.ts",
  version: 1,
};
document["x-lite-api-version"] = LITE_API_VERSION;
document.components.schemas.CreateRun = clone(CreateRunRequestSchema);
document.components.schemas.RunBudgetOverrides = clone(RunBudgetOverridesSchema);
document.components.schemas.CreateAgent = clone(CreateAgentProfileRequestSchema);
document.components.schemas.CreateWorkspace = clone(CreateWorkspaceRequestSchema);
document.components.schemas.ErrorEnvelope = clone(ErrorEnvelopeSchema);
document.components.schemas.MintRunToken = clone(MintRunTokenRequestSchema);
document.components.schemas.MintRunTokenResponse = clone(MintRunTokenResponseSchema);
document.components.schemas.RevokeTokenResponse = clone(RevokeTokenResponseSchema);
document.components.schemas.PublishArtifact = clone(PublishArtifactRequestSchema);
document.paths["/v1/tokens"] = {
  post: {
    summary: "Mint a short-lived resource-bound run token",
    security: [{ appToken: [] }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/MintRunToken" } } },
    },
    responses: {
      "201": {
        description: "Run token minted",
        content: { "application/json": { schema: { $ref: "#/components/schemas/MintRunTokenResponse" } } },
      },
      "400": { description: "Invalid request" },
      "403": { description: "Scope or resource binding expansion" },
    },
  },
};
document.paths["/v1/tokens/{tokenId}"] = {
  delete: {
    summary: "Revoke a run token owned by the authenticated app",
    security: [{ appToken: [] }],
    parameters: [{ name: "tokenId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } }],
    responses: {
      "200": {
        description: "Run token revoked",
        content: { "application/json": { schema: { $ref: "#/components/schemas/RevokeTokenResponse" } } },
      },
      "404": { description: "Token not found" },
    },
  },
};

for (const [route, pathItem] of Object.entries(document.paths) as Array<[string, Record<string, any>]>) {
  for (const [method, operation] of Object.entries(pathItem) as Array<[string, Record<string, any>]>) {
    if (!operation || typeof operation !== "object" || !operation.responses) continue;
    operation.operationId = operationId(method, route);
    for (const [status, response] of Object.entries(operation.responses) as Array<[string, Record<string, any>]>) {
      if (!/^[45]/.test(status)) continue;
      response.content ??= {};
      response.content["application/json"] ??= {};
      response.content["application/json"].schema = { $ref: "#/components/schemas/ErrorEnvelope" };
    }
  }
}

const gateway = readFileSync(resolve(root, "apps", "gateway", "src", "server.ts"), "utf8");
const publicRoutes = new Set(
  [...gateway.matchAll(/["`](\/(?:healthz|readyz|hooks|v1)[^"`]*)["`]/g)]
    .map((match) => match[1] as string)
    .filter((route) => !route.includes("${") && route !== "/hooks/" && route !== "/v1/")
    .map((route) => route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}")),
);
const missing = [...publicRoutes].filter((route) => !(route in document.paths));
if (missing.length) throw new Error(`OpenAPI is missing public Gateway routes: ${missing.join(", ")}`);

const content = `${JSON.stringify(document, null, 2)}\n`;
const typescriptSdkPath = resolve(root, "packages", "sdk-typescript", "src", "generated-api.ts");
const pythonSdkPath = resolve(root, "sdks", "python", "src", "lite_harness", "generated_api.py");
const typescriptSdk = generateTypescriptSdk(document);
const pythonSdk = generatePythonSdk(document);
if (process.argv.includes("--check")) {
  const stale = [
    [path, content],
    [typescriptSdkPath, typescriptSdk],
    [pythonSdkPath, pythonSdk],
  ].filter(([output, expected]) => readFileSync(output!, "utf8").replaceAll("\r\n", "\n") !== expected);
  if (stale.length) throw new Error(`Generated API outputs are stale: ${stale.map(([output]) => output).join(", ")}`);
  process.stdout.write(`OpenAPI and SDK model checks passed for ${Object.keys(document.paths).length} paths.\n`);
} else {
  writeFileSync(path, content);
  writeFileSync(typescriptSdkPath, typescriptSdk);
  writeFileSync(pythonSdkPath, pythonSdk);
  process.stdout.write(`Generated OpenAPI and SDK models from authoritative contracts with ${Object.keys(document.paths).length} paths.\n`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function operationId(method: string, route: string): string {
  const expanded = route.replace(/\{([^}]+)\}/g, " by $1 ");
  const words = expanded.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/);
  const name = words.map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`).join("");
  return `${method.toLowerCase()}${name}`;
}

function apiOperations(document: Record<string, any>): Array<{ method: string; path: string; operationId: string }> {
  const operations: Array<{ method: string; path: string; operationId: string }> = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {}) as Array<[string, Record<string, any>]>) {
    for (const [method, operation] of Object.entries(pathItem) as Array<[string, Record<string, any>]>) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      operations.push({ method: method.toUpperCase(), path, operationId: String(operation.operationId) });
    }
  }
  return operations.sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
}

function generateTypescriptSdk(document: Record<string, any>): string {
  return `/* Generated by scripts/generate-openapi.ts. Do not edit. */
export type {
  CreateAgentProfileRequest as CreateAgent,
  CreateRunRequest as CreateRun,
  CreateWorkspaceRequest as CreateWorkspace,
  ErrorEnvelope,
  MintRunTokenRequest as MintRunToken,
  MintRunTokenResponse,
  PublishArtifactRequest as PublishArtifact,
  RevokeTokenResponse,
  RunBudgetOverrides,
} from "@lite-harness/contracts";

export const GENERATED_API_OPERATIONS = ${JSON.stringify(apiOperations(document), null, 2)} as const;
export type GeneratedApiOperation = (typeof GENERATED_API_OPERATIONS)[number];
export type GeneratedApiOperationId = GeneratedApiOperation["operationId"];
`;
}

function generatePythonSdk(document: Record<string, any>): string {
  const schemas = document.components?.schemas ?? {};
  const declarations = Object.entries(schemas).map(([name, schema]) => pythonDeclaration(name, schema as Record<string, any>));
  const exports = [...Object.keys(schemas), "API_OPERATIONS"];
  const operations = apiOperations(document).map((item) => `    (${JSON.stringify(item.method)}, ${JSON.stringify(item.path)}, ${JSON.stringify(item.operationId)}),`).join("\n");
  return `# Generated by scripts/generate-openapi.ts. Do not edit.
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypeAlias, TypedDict

${declarations.join("\n\n")}

API_OPERATIONS: tuple[tuple[str, str, str], ...] = (
${operations}
)

__all__ = ${JSON.stringify(exports)}
`;
}

function pythonDeclaration(name: string, schema: Record<string, any>): string {
  if (schema.type !== "object" || !schema.properties) return `${name}: TypeAlias = ${pythonType(schema)}`;
  const required = new Set<string>(schema.required ?? []);
  const fields = Object.entries(schema.properties as Record<string, Record<string, any>>)
    .map(([field, value]) => `    ${field}: ${required.has(field) ? pythonType(value) : `NotRequired[${pythonType(value)}]`}`);
  return `class ${name}(TypedDict):\n${fields.length ? fields.join("\n") : "    pass"}`;
}

function pythonType(schema: Record<string, any>): string {
  if (schema.$ref) return String(schema.$ref).split("/").at(-1) ?? "Any";
  if (Array.isArray(schema.enum) && schema.enum.length) return `Literal[${schema.enum.map((value: unknown) => JSON.stringify(value)).join(", ")}]`;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return alternatives.map((item) => pythonType(item)).join(" | ");
  if (schema.type === "string") return "str";
  if (schema.type === "integer") return "int";
  if (schema.type === "number") return "float";
  if (schema.type === "boolean") return "bool";
  if (schema.type === "array") return `list[${pythonType(schema.items ?? {})}]`;
  if (schema.type === "null") return "None";
  if (schema.type === "object") return "dict[str, Any]";
  return "Any";
}
