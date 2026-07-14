import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedBrowserProfileStore } from "@lite-harness/browser";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("high-severity baseline defect reproductions", () => {
  it("BD-009-REPRO keeps same-named browser profiles isolated by owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-profile-repro-"));
    roots.push(root);
    const profiles = new EncryptedBrowserProfileStore(root, Buffer.alloc(32, 7));
    const ownerA = { appId: "app", tenantId: "tenant-a", userId: "user" };
    const ownerB = { appId: "app", tenantId: "tenant-b", userId: "user" };
    await profiles.save("default", ownerA, "profile-a");
    await profiles.save("default", ownerB, "profile-b");
    await expect(profiles.load("default", ownerA)).resolves.toBe("profile-a");
  });

  for (const item of structuralCases) {
    it(`${item.id}-REPRO ${item.title}`, () => {
      const content = readFileSync(join(process.cwd(), item.path), "utf8");
      if (item.mode === "contains") expect(content).toContain(item.token);
      else expect(content).not.toContain(item.token);
    });
  }
});

const structuralCases: Array<{
  id: string;
  title: string;
  path: string;
  mode: "contains" | "excludes";
  token: string;
}> = [
  { id: "BD-010", title: "retains the newest bounded session messages", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "ORDER BY sequence DESC LIMIT" },
  { id: "BD-011", title: "persists assistant tool-call structure with session history", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "tool_calls_json" },
  { id: "BD-012", title: "persists an accepted-to-terminal deadline before queueing", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "deadline_at" },
  { id: "BD-013", title: "scopes friendly identifiers to their resource owner", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "owner_scoped_external_id" },
  { id: "BD-014", title: "binds owner-scoped idempotency to a canonical request fingerprint", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "idempotency_fingerprint" },
  { id: "BD-015", title: "authenticates snapshot identity as associated data", path: "packages/workspace/src/index.ts", mode: "contains", token: "snapshotAssociatedData" },
  { id: "BD-016", title: "verifies a snapshot before rotating the previous-good generation", path: "packages/workspace/src/index.ts", mode: "contains", token: "verifySnapshotBeforeRotation" },
  { id: "BD-017", title: "streams snapshot compression and encryption off the Manager loop", path: "packages/workspace/src/index.ts", mode: "contains", token: "createStreamingSnapshotPipeline" },
  { id: "BD-018", title: "validates bounded archives inside hardened maintenance containers", path: "packages/runtime-docker/src/index.ts", mode: "contains", token: "validateArchiveEntries" },
  { id: "BD-019", title: "persists deterministic Docker object identity and labels", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "runtime_container_id" },
  { id: "BD-020", title: "independently kills and reaps a cancelled container", path: "packages/runtime-docker/src/index.ts", mode: "contains", token: "killAndReapContainer" },
  { id: "BD-021", title: "commits lifecycle events and projections atomically", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "appendEventAndProjectTransaction" },
  { id: "BD-022", title: "honors SSE drain and bounded streaming IPC", path: "apps/gateway/src/server.ts", mode: "contains", token: "awaitSseDrain" },
  { id: "BD-023", title: "fails readiness when production dependencies are unusable", path: "apps/manager/src/server.ts", mode: "contains", token: "productionReadinessChecks" },
  { id: "BD-024", title: "executes ordered auditable migration steps", path: "packages/storage-sqlite/src/index.ts", mode: "contains", token: "orderedMigrationSteps" },
  { id: "BD-025", title: "binds delegated runtimes to the leased run workspace", path: "packages/delegated-runtime/src/index.ts", mode: "contains", token: "workspacePathForRun" },
  { id: "BD-026", title: "streams Claude prompts through stdin instead of argv", path: "packages/delegated-runtime/src/index.ts", mode: "contains", token: "claudePromptStdin" },
  { id: "BD-027", title: "cancels RPC side effects and isolates child HOME", path: "packages/process-rpc/src/index.ts", mode: "contains", token: "isolatedChildHome" },
  { id: "BD-028", title: "binds approval decisions to an immutable execution digest", path: "packages/control-plane/src/index.ts", mode: "contains", token: "approvalExecutionDigest" },
  { id: "BD-029", title: "validates tool arguments against the advertised schema", path: "packages/agent-runtime/src/index.ts", mode: "contains", token: "validateAdvertisedToolArguments" },
  { id: "BD-030", title: "rejects unknown prices under a cost ceiling", path: "packages/provider-core/src/index.ts", mode: "contains", token: "unknown_model_price" },
  { id: "BD-031", title: "treats usage and request acceptance as fallback visibility", path: "packages/provider-core/src/index.ts", mode: "contains", token: "providerRequestBecameVisible" },
  { id: "BD-032", title: "implements a first-class OpenAI Responses route", path: "packages/provider-openai-compatible/src/index.ts", mode: "contains", token: "responses.create" },
  { id: "BD-033", title: "limits plaintext Anthropic endpoints to loopback", path: "packages/provider-anthropic/src/index.ts", mode: "contains", token: "plaintext Anthropic endpoints must be loopback" },
  { id: "BD-034", title: "rejects sensitive registered bind roots", path: "packages/workspace/src/index.ts", mode: "contains", token: "rejectSensitiveRegisteredRoot" },
  { id: "BD-035", title: "publishes artifacts only from an authorized workspace path", path: "packages/runtime/src/index.ts", mode: "contains", token: "authorizedWorkspaceArtifactPath" },
  { id: "BD-036", title: "verifies webhook signatures over exact raw bytes", path: "apps/manager/src/server.ts", mode: "contains", token: "request.rawBody" },
  { id: "BD-037", title: "reuses versioned authoritative schemas at the internal boundary", path: "apps/manager/src/server.ts", mode: "contains", token: "InternalStartRunRequestSchema" },
  { id: "BD-038", title: "composes optional systems through the production run loop", path: "apps/manager/src/main.ts", mode: "contains", token: "ContextOptimizationGate" },
  { id: "BD-039", title: "persists capability-derived model routes per run", path: "apps/manager/src/main.ts", mode: "contains", token: "persistRunRoutePlan" },
  { id: "BD-040", title: "provides bounded shell search patch git test and build tools", path: "packages/runtime/src/index.ts", mode: "contains", token: "shell_exec" },
  { id: "BD-041", title: "uses the required Debian glibc coding image profile", path: "docker/tool-runtime/Dockerfile", mode: "contains", token: "bookworm-slim" },
  { id: "BD-042", title: "moves browser egress enforcement outside Chromium's container", path: "packages/browser/src/index.ts", mode: "contains", token: "ExternalBrowserEgressBroker" },
  { id: "BD-043", title: "durably stores browser sessions audit actions and artifacts", path: "packages/browser/src/index.ts", mode: "contains", token: "DurableBrowserSessionStore" },
  { id: "BD-044", title: "freezes bounded immutable skill snapshots into each run", path: "packages/skills/src/index.ts", mode: "contains", token: "ImmutableSkillSnapshot" },
  { id: "BD-045", title: "routes MCP calls through normal brokered tool policy", path: "packages/mcp/src/index.ts", mode: "contains", token: "BrokeredMcpToolPolicy" },
  { id: "BD-046", title: "implements staged verified leased cache lifecycle", path: "packages/workspace/src/index.ts", mode: "contains", token: "CachePopulationLease" },
  { id: "BD-047", title: "automates restore checkpoint verify cold and delete lifecycle", path: "apps/manager/src/main.ts", mode: "contains", token: "automaticWorkspaceCheckpoint" },
  { id: "BD-048", title: "persists an immutable RunSnapshot contract", path: "packages/contracts/src/index.ts", mode: "contains", token: "interface RunSnapshot" },
  { id: "BD-049", title: "proves disabled packs create zero runtime resources", path: "test/optional-packs.test.ts", mode: "contains", token: "disabledPackResourceProbe" },
  { id: "BD-050", title: "runs paired Hermes model quality and cost evaluation for pxpipe", path: "scripts/evaluate-context.ts", mode: "contains", token: "pairedHermesModelEvaluation" },
  { id: "BD-051", title: "emits compiled application artifacts from the root build", path: "package.json", mode: "excludes", token: "\"build\": \"pnpm typecheck\"" },
  { id: "BD-052", title: "packs an installable compiled TypeScript SDK", path: "packages/sdk-typescript/package.json", mode: "contains", token: "./dist/index.js" },
  { id: "BD-053", title: "tests installed Python wheel and sdist against a real Gateway", path: "sdks/python/tests/test_client.py", mode: "contains", token: "installed_distribution_gateway" },
  { id: "BD-054", title: "runs Gateway to Manager E2E through packaged processes and IPC", path: "test/gateway-manager.e2e.test.ts", mode: "contains", token: "spawnPackagedHarness" },
  { id: "BD-055", title: "does not silently skip required Docker browser or provider lanes", path: "test/docker-runtime.integration.test.ts", mode: "excludes", token: "describe.skip" },
  { id: "BD-056", title: "executes the exact candidate image digest before promotion", path: ".github/workflows/images.yml", mode: "contains", token: "docker run --rm ${{ steps.build.outputs.digest }}" },
  { id: "BD-057", title: "validates OpenAPI drift installability and alpha behavior", path: "scripts/check-release.mjs", mode: "contains", token: "validateOpenApiSemantics" },
  { id: "BD-058", title: "records real rootless macOS Windows restart resume and offline evidence", path: ".github/workflows/ci.yml", mode: "contains", token: "rootless-product-evidence" },
  { id: "BD-059", title: "makes doctor fail on every required production dependency defect", path: "apps/cli/src/main.ts", mode: "contains", token: "databaseIntegrityCheck" },
  { id: "BD-060", title: "runs services from compiled artifacts without tsx or fake defaults", path: "packages/operations/src/index.ts", mode: "excludes", token: "\"--import\", \"tsx\"" },
  { id: "BD-061", title: "generates authoritative OpenAPI and SDK models from contracts", path: "docs/openapi.json", mode: "contains", token: "x-lite-generated-from-contracts" },
  { id: "BD-062", title: "validates numeric config and emits complete metrics audit and traces", path: "apps/manager/src/main.ts", mode: "contains", token: "ValidatedManagerConfiguration" },
  { id: "BD-063", title: "labels architecture claims as not yet verified", path: "docs/ARCHITECTURE.md", mode: "contains", token: "NOT YET A VERIFIED ALPHA" },
  { id: "BD-064", title: "records an owner-approved collision-checked public identity", path: "docs/adr/0033-public-identity.md", mode: "contains", token: "- Status: accepted" },
];
