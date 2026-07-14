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

for (const pathItem of Object.values(document.paths) as Array<Record<string, any>>) {
  for (const operation of Object.values(pathItem) as Array<Record<string, any>>) {
    if (!operation || typeof operation !== "object" || !operation.responses) continue;
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
