import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const surfaces = Object.freeze({
  unit: [
    "test/agent-runtime.test.ts", "test/agent-tool-validation.test.ts", "test/approval.test.ts",
    "test/approval-binding.test.ts", "test/auth.test.ts", "test/backpressure.test.ts", "test/budgets.test.ts",
    "test/cache-lifecycle.test.ts", "test/capabilities.test.ts", "test/config.test.ts", "test/credential-store.test.ts",
    "test/domain.test.ts", "test/idempotency.test.ts", "test/lifecycle-safety.test.ts", "test/model-routing-persistence.test.ts",
    "test/operations.test.ts", "test/owner-scoped-identities.test.ts", "test/process-extensions.test.ts",
    "test/process-rpc-safety.test.ts", "test/provider-adapters.test.ts", "test/provider-core.test.ts",
    "test/provider-cost-accounting.test.ts", "test/pxpipe-version.test.ts", "test/queue-deadline.test.ts",
    "test/session-history.test.ts", "test/storage.test.ts", "test/transactional-projections.test.ts",
    "test/workspace.test.ts", "test/runtime.test.ts",
  ],
  contracts: ["test/internal-boundary-schemas.test.ts", "test/sdk-contracts.test.ts", "test/openapi-route-discovery.test.ts", "test/capabilities.test.ts", "test/config.test.ts"],
  ipc: ["test/ipc.test.ts", "test/process-rpc-safety.test.ts"],
  sdk: ["test/sdk-contracts.test.ts", "test/sdk-reconnect.test.ts"],
  skills: ["test/skill-lifecycle.test.ts"],
  mcp: ["test/mcp-http.test.ts", "test/mcp-isolation.test.ts"],
  automation: ["test/automation.test.ts"],
  subagents: ["test/subagents-memory-live.test.ts"],
  security: [
    "test/auth.test.ts", "test/approval.test.ts", "test/approval-binding.test.ts", "test/agent-tool-validation.test.ts",
    "test/credential-store.test.ts", "test/browser-egress.test.ts", "test/lifecycle-safety.test.ts",
  ],
  chaos: ["test/recovery.test.ts", "test/lifecycle-safety.test.ts", "test/docker-archive.test.ts"],
});

const surface = process.argv[2];
if (!surface || !Object.hasOwn(surfaces, surface)) {
  throw new Error(`Unknown test surface ${surface ?? "<missing>"}. Expected one of: ${Object.keys(surfaces).join(", ")}`);
}
const files = surfaces[surface];
const missing = files.filter((file) => !existsSync(resolve(root, file)));
if (missing.length) throw new Error(`Test surface ${surface} references missing files: ${missing.join(", ")}`);

const result = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", ...files, ...process.argv.slice(3)], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
