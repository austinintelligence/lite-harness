import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentListResponseSchema,
  AgentModelCapabilitySchema,
  AgentProfileRecordSchema,
  ApprovalRecordSchema,
  ApprovalStatusSchema,
  ArtifactPayloadResponseSchema,
  ArtifactRecordSchema,
  ChildRunsResponseSchema,
  CreateAgentProfileRequestSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  CreateWorkspaceRequestSchema,
  ErrorDetailSchema,
  ErrorEnvelopeSchema,
  GatewayHealthSchema,
  GatewayReadinessSchema,
  InboundEnvelopeSchema,
  LITE_API_VERSION,
  MintRunTokenRequestSchema,
  MintRunTokenResponseSchema,
  PublishArtifactRequestSchema,
  RevokeTokenResponseSchema,
  ReadinessDependencySchema,
  ResolveApprovalRequestSchema,
  RunAttemptRecordSchema,
  RunAttemptsResponseSchema,
  RunBudgetOverridesSchema,
  RunBudgetSchema,
  RunEventSchema,
  RunEventTypeSchema,
  RunRecordSchema,
  RunStatusSchema,
  RunUsageSchema,
  SessionMessageRecordSchema,
  SessionMessageRoleSchema,
  SessionMessagesResponseSchema,
  SessionRecordSchema,
  StructuredErrorSchema,
  SteerRunRequestSchema,
  WebhookIngestResponseSchema,
  WorkspaceListResponseSchema,
  WorkspaceRecordSchema,
} from "@lite-harness/contracts";

const root = resolve(import.meta.dirname, "..");
const path = resolve(root, "docs", "openapi.json");
const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

const publicSchemas: Record<string, unknown> = {
  AgentListResponse: AgentListResponseSchema,
  AgentModelCapability: AgentModelCapabilitySchema,
  AgentProfileRecord: AgentProfileRecordSchema,
  ApprovalRecord: ApprovalRecordSchema,
  ApprovalStatus: ApprovalStatusSchema,
  ArtifactPayloadResponse: ArtifactPayloadResponseSchema,
  ArtifactRecord: ArtifactRecordSchema,
  ChildRunsResponse: ChildRunsResponseSchema,
  CreateAgent: CreateAgentProfileRequestSchema,
  CreateRun: CreateRunRequestSchema,
  CreateRunResponse: CreateRunResponseSchema,
  CreateWorkspace: CreateWorkspaceRequestSchema,
  ErrorDetail: ErrorDetailSchema,
  ErrorEnvelope: ErrorEnvelopeSchema,
  GatewayHealth: GatewayHealthSchema,
  GatewayReadiness: GatewayReadinessSchema,
  InboundEnvelope: InboundEnvelopeSchema,
  MintRunToken: MintRunTokenRequestSchema,
  MintRunTokenResponse: MintRunTokenResponseSchema,
  PublishArtifact: PublishArtifactRequestSchema,
  RevokeTokenResponse: RevokeTokenResponseSchema,
  ReadinessDependency: ReadinessDependencySchema,
  ResolveApproval: ResolveApprovalRequestSchema,
  RunAttemptRecord: RunAttemptRecordSchema,
  RunAttemptsResponse: RunAttemptsResponseSchema,
  RunBudget: RunBudgetSchema,
  RunBudgetOverrides: RunBudgetOverridesSchema,
  RunEvent: RunEventSchema,
  RunEventType: RunEventTypeSchema,
  RunRecord: RunRecordSchema,
  RunStatus: RunStatusSchema,
  RunUsage: RunUsageSchema,
  SessionMessageRecord: SessionMessageRecordSchema,
  SessionMessageRole: SessionMessageRoleSchema,
  SessionMessagesResponse: SessionMessagesResponseSchema,
  SessionRecord: SessionRecordSchema,
  SteerRun: SteerRunRequestSchema,
  StructuredError: StructuredErrorSchema,
  WebhookIngestResponse: WebhookIngestResponseSchema,
  WorkspaceListResponse: WorkspaceListResponseSchema,
  WorkspaceRecord: WorkspaceRecordSchema,
};

document["x-lite-generated-from-contracts"] = {
  source: "packages/contracts/src/index.ts",
  version: 2,
};
document["x-lite-api-version"] = LITE_API_VERSION;
document["x-lite-contract-schemas"] = Object.keys(publicSchemas);
document.components ??= {};
const schemaDocuments = Object.fromEntries(
  Object.entries(publicSchemas).map(([name, schema]) => [name, clone(schema)]),
);
const canonicalSchemas = new Map(Object.entries(schemaDocuments).map(([name, schema]) => [JSON.stringify(schema), name]));
document.components.schemas = Object.fromEntries(
  Object.entries(schemaDocuments).map(([name, schema]) => [name, rewriteSchemaReferences(schema as Record<string, any>, name, canonicalSchemas)]),
);

type RouteContract = {
  requestSchema?: string;
  requestRequired?: boolean;
  successStatus: string;
  successSchema: string;
  successDescription: string;
  successContentType?: string;
  parameters?: Array<Record<string, unknown>>;
};

const routeContracts: Record<string, RouteContract> = {
  "GET /healthz": { successStatus: "200", successSchema: "GatewayHealth", successDescription: "Gateway health" },
  "GET /readyz": { successStatus: "200", successSchema: "GatewayReadiness", successDescription: "Gateway readiness" },
  "POST /hooks/webhook/{accountId}": {
    requestSchema: "InboundEnvelope", successStatus: "202", successSchema: "WebhookIngestResponse", successDescription: "Accepted or duplicate delivery",
    parameters: [
      { name: "accountId", in: "path", required: true, schema: stringSchema(1, 128) },
      { name: "X-Lite-Signature", in: "header", required: true, schema: { type: "string", pattern: "^sha256=[a-fA-F0-9]{64}$" } },
    ],
  },
  "POST /v1/runs": { requestSchema: "CreateRun", successStatus: "202", successSchema: "CreateRunResponse", successDescription: "Accepted or replayed" },
  "GET /v1/runs/{runId}": { successStatus: "200", successSchema: "RunRecord", successDescription: "Run" },
  "GET /v1/runs/{runId}/events": {
    successStatus: "200", successSchema: "RunEvent", successDescription: "Replayable SSE event stream", successContentType: "text/event-stream",
    parameters: [{ name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0 } }],
  },
  "GET /v1/runs/{runId}/attempts": { successStatus: "200", successSchema: "RunAttemptsResponse", successDescription: "Durable execution attempts" },
  "GET /v1/runs/{runId}/children": { successStatus: "200", successSchema: "ChildRunsResponse", successDescription: "Owned direct child runs" },
  "POST /v1/runs/{runId}/cancel": { successStatus: "200", successSchema: "RunRecord", successDescription: "Cancelled or terminal run" },
  "POST /v1/runs/{runId}/steer": { requestSchema: "SteerRun", successStatus: "200", successSchema: "RunRecord", successDescription: "Instruction queued" },
  "GET /v1/sessions/{sessionId}": { successStatus: "200", successSchema: "SessionRecord", successDescription: "Session" },
  "GET /v1/sessions/{sessionId}/messages": { successStatus: "200", successSchema: "SessionMessagesResponse", successDescription: "Session messages" },
  "POST /v1/approvals/{approvalId}": { requestSchema: "ResolveApproval", successStatus: "200", successSchema: "ApprovalRecord", successDescription: "Approval resolved" },
  "POST /v1/runs/{runId}/artifacts": { requestSchema: "PublishArtifact", successStatus: "201", successSchema: "ArtifactRecord", successDescription: "Artifact published" },
  "GET /v1/artifacts/{artifactId}": { successStatus: "200", successSchema: "ArtifactPayloadResponse", successDescription: "Artifact metadata and base64 data" },
  "GET /v1/agents": { successStatus: "200", successSchema: "AgentListResponse", successDescription: "Owned agent profiles" },
  "POST /v1/agents": { requestSchema: "CreateAgent", successStatus: "201", successSchema: "AgentProfileRecord", successDescription: "Agent profile created" },
  "GET /v1/agents/{agentId}": { successStatus: "200", successSchema: "AgentProfileRecord", successDescription: "Agent profile" },
  "GET /v1/workspaces": { successStatus: "200", successSchema: "WorkspaceListResponse", successDescription: "Owned workspaces" },
  "POST /v1/workspaces": { requestSchema: "CreateWorkspace", requestRequired: false, successStatus: "201", successSchema: "WorkspaceRecord", successDescription: "Managed workspace created" },
  "GET /v1/workspaces/{workspaceId}": { successStatus: "200", successSchema: "WorkspaceRecord", successDescription: "Workspace" },
  "POST /v1/tokens": { requestSchema: "MintRunToken", successStatus: "201", successSchema: "MintRunTokenResponse", successDescription: "Run token minted" },
  "DELETE /v1/tokens/{tokenId}": { successStatus: "200", successSchema: "RevokeTokenResponse", successDescription: "Run token revoked" },
};

for (const [route, pathItem] of Object.entries(document.paths ?? {}) as Array<[string, Record<string, any>]>) {
  for (const [method, operation] of Object.entries(pathItem) as Array<[string, Record<string, any>]>) {
    if (!operation || typeof operation !== "object" || !operation.responses) continue;
    const key = `${method.toUpperCase()} ${route}`;
    const contract = routeContracts[key];
    if (!contract) throw new Error(`OpenAPI route has no authoritative contract: ${key}`);
    operation.operationId = operationId(method, route);
    operation.security = route.startsWith("/v1/") ? [{ appToken: [] }] : [];
    operation.responses = {
      ...operation.responses,
      [contract.successStatus]: {
        description: contract.successDescription,
        content: { [contract.successContentType ?? "application/json"]: { schema: { $ref: `#/components/schemas/${contract.successSchema}` } } },
      },
    };
    if (contract.requestSchema) {
      operation.requestBody = {
        required: contract.requestRequired ?? true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${contract.requestSchema}` } } },
      };
    } else {
      delete operation.requestBody;
    }
    operation.parameters = mergeParameters(route, operation.parameters, contract.parameters);
    for (const [status, response] of Object.entries(operation.responses) as Array<[string, Record<string, any>]>) {
      if (!/^[45]/.test(status)) continue;
      response.content ??= {};
      response.content["application/json"] ??= {};
      response.content["application/json"].schema = { $ref: "#/components/schemas/ErrorEnvelope" };
    }
  }
}

// Readiness uses the same dependency object for both HTTP 200 and 503; a
// caller must be able to inspect the failing dependency instead of receiving
// an unrelated error envelope.
document.paths["/readyz"].get.responses["503"] = {
  description: "Gateway dependencies are not ready",
  content: { "application/json": { schema: { $ref: "#/components/schemas/GatewayReadiness" } } },
};

const gateway = readFileSync(resolve(root, "apps", "gateway", "src", "server.ts"), "utf8");
const publicRoutes = new Set(
  [...gateway.matchAll(/["`](\/(?:healthz|readyz|hooks|v1)[^"`]*)["`]/g)]
    .map((match) => match[1] as string)
    .filter((route) => !route.includes("${") && route !== "/hooks/" && route !== "/v1/")
    .map((route) => route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}")),
);
const missing = [...publicRoutes].filter((route) => !(route in document.paths));
if (missing.length) throw new Error(`OpenAPI is missing public Gateway routes: ${missing.join(", ")}`);

const uncontracted = Object.entries(document.paths ?? {}).flatMap(([route, item]) =>
  Object.keys(item as Record<string, unknown>)
    .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
    .filter((method) => !routeContracts[`${method.toUpperCase()} ${route}`])
    .map((method) => `${method.toUpperCase()} ${route}`),
);
if (uncontracted.length) throw new Error(`OpenAPI has uncontracted public operations: ${uncontracted.join(", ")}`);

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
  process.stdout.write(`OpenAPI and SDK model checks passed for ${Object.keys(document.paths).length} paths and ${Object.keys(publicSchemas).length} schemas.\n`);
} else {
  writeFileSync(path, content);
  writeFileSync(typescriptSdkPath, typescriptSdk);
  writeFileSync(pythonSdkPath, pythonSdk);
  process.stdout.write(`Generated OpenAPI and SDK models from authoritative contracts with ${Object.keys(document.paths).length} paths and ${Object.keys(publicSchemas).length} schemas.\n`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rewriteSchemaReferences(
  value: Record<string, any>,
  owner: string,
  canonicalSchemas: Map<string, string>,
): Record<string, any> {
  const rewrite = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    if (!Array.isArray(node)) {
      const referenced = canonicalSchemas.get(JSON.stringify(node));
      if (referenced && referenced !== owner) return { $ref: `#/components/schemas/${referenced}` };
    }
    if (Array.isArray(node)) return node.map(rewrite);
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, rewrite(child)]));
  };
  return rewrite(value) as Record<string, any>;
}

function stringSchema(minLength: number, maxLength: number): Record<string, unknown> {
  return { type: "string", minLength, maxLength };
}

function mergeParameters(route: string, existing: unknown, explicit?: Array<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
  const parameters = new Map<string, Record<string, unknown>>();
  for (const parameter of (explicit ?? existing ?? []) as Array<Record<string, unknown>>) {
    if (parameter?.name && parameter?.in) parameters.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    parameters.set(`path:${name}`, { name, in: "path", required: true, schema: stringSchema(1, 128) });
  }
  return parameters.size ? [...parameters.values()] : undefined;
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
  const schemas = document.components?.schemas ?? {};
  const declarations = Object.entries(schemas).map(([name, schema]) => {
    const type = typescriptType(schema as Record<string, any>);
    return `export type ${name} =${type.startsWith("\n") ? "" : " "}${type};`;
  });
  return `/* Generated by scripts/generate-openapi.ts. Do not edit. */
${declarations.join("\n")}

export const GENERATED_API_SCHEMAS = ${JSON.stringify(Object.keys(schemas), null, 2)} as const;
export type GeneratedApiSchemaName = (typeof GENERATED_API_SCHEMAS)[number];
export const GENERATED_API_OPERATIONS = ${JSON.stringify(apiOperations(document), null, 2)} as const;
export type GeneratedApiOperation = (typeof GENERATED_API_OPERATIONS)[number];
export type GeneratedApiOperationId = GeneratedApiOperation["operationId"];
`;
}

function typescriptType(schema: Record<string, any>, indent = ""): string {
  if (schema.$ref) return String(schema.$ref).split("/").at(-1) ?? "unknown";
  if (Object.prototype.hasOwnProperty.call(schema, "const")) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.map((value: unknown) => JSON.stringify(value)).join(" | ");
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return alternatives.map((item) => typescriptType(item, indent)).join(" | ");
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return `Array<${typescriptType(schema.items ?? {}, indent)}>`;
  if (schema.type === "null") return "null";
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, Record<string, any>> | undefined;
    if (!properties) {
      const pattern = schema.patternProperties && Object.values(schema.patternProperties)[0] as Record<string, any> | undefined;
      return `Record<string, ${typescriptType(pattern ?? {}, indent)}>`;
    }
    const required = new Set<string>(schema.required ?? []);
    const fields = Object.entries(properties).map(([field, value]) => {
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field) ? field : JSON.stringify(field);
      return `${indent}  ${name}${required.has(field) ? "" : "?"}: ${typescriptType(value, `${indent}  `)};`;
    });
    return fields.length ? `\n${indent}{\n${fields.join("\n")}\n${indent}}` : "Record<string, never>";
  }
  return "unknown";
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
  if (Object.prototype.hasOwnProperty.call(schema, "const")) return pythonLiteral(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return `Literal[${schema.enum.map((value: unknown) => pythonLiteral(value)).join(", ")}]`;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    if (alternatives.every((item) => Object.prototype.hasOwnProperty.call(item, "const"))) {
      return `Literal[${alternatives.map((item) => pythonLiteral(item.const)).join(", ")}]`;
    }
    return alternatives.map((item) => pythonType(item)).join(" | ");
  }
  if (schema.type === "string") return "str";
  if (schema.type === "integer") return "int";
  if (schema.type === "number") return "float";
  if (schema.type === "boolean") return "bool";
  if (schema.type === "array") return `list[${pythonType(schema.items ?? {})}]`;
  if (schema.type === "null") return "None";
  if (schema.type === "object") {
    const pattern = schema.patternProperties && Object.values(schema.patternProperties)[0] as Record<string, any> | undefined;
    return pattern ? `dict[str, ${pythonType(pattern)}]` : "dict[str, Any]";
  }
  return "Any";
}

function pythonLiteral(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return JSON.stringify(value);
}
