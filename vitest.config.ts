import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const deterministicWorkspaceFiles = [
  "test/workspace.test.ts",
  "test/workspace-lifecycle.test.ts",
];
const realRuntimeOnlyFiles = [
  "test/required-real-runtime.test.ts",
  "test/packaged-docker-vertical.integration.test.ts",
  "test/docker-runtime.integration.test.ts",
  "test/docker-workspace-lifecycle.integration.test.ts",
  "test/docker-workspace-restart.integration.test.ts",
  "test/docker-plugin.integration.test.ts",
  "test/docker-plugin-manager.integration.test.ts",
  "test/docker-mcp.integration.test.ts",
  "test/browser-integrations.test.ts",
];
const mcpAlphaEvidenceFiles = [
  "test/mcp-isolation.test.ts",
  "test/mcp-http.test.ts",
  "test/optional-systems-manager.test.ts",
];
const pluginAlphaEvidenceFiles = [
  "test/plugin-lifecycle-manager.test.ts",
];
const scaleToZeroEvidenceFiles = [
  "test/config.test.ts",
  "test/optional-packs.test.ts",
  "test/capabilities.test.ts",
  "test/browser-idle.test.ts",
  "test/provider-adapters.test.ts",
  "test/process-extensions.test.ts",
];
const realRuntimeFiles = [
  ...deterministicWorkspaceFiles, ...realRuntimeOnlyFiles, ...mcpAlphaEvidenceFiles, ...pluginAlphaEvidenceFiles,
  ...scaleToZeroEvidenceFiles, "test/storage.test.ts",
];
const hermesFiles = ["test/hermes-provider.live.test.ts"];
const realRuntime = process.env.LITE_HARNESS_REAL_RUNTIME_TEST === "1";
const liveHermes = process.env.LITE_HARNESS_LIVE_MODEL_TEST === "hermes";

export default defineConfig({
  resolve: {
    alias: {
      "@lite-harness/contracts": source("./packages/contracts/src/index.ts"),
      "@lite-harness/config": source("./packages/config/src/index.ts"),
      "@lite-harness/auth": source("./packages/auth/src/index.ts"),
      "@lite-harness/auth-sqlite": source("./packages/auth-sqlite/src/index.ts"),
      "@lite-harness/domain": source("./packages/domain/src/index.ts"),
      "@lite-harness/storage-sqlite": source("./packages/storage-sqlite/src/index.ts"),
      "@lite-harness/agent-runtime": source("./packages/agent-runtime/src/index.ts"),
      "@lite-harness/runtime": source("./packages/runtime/src/index.ts"),
      "@lite-harness/runtime-docker": source("./packages/runtime-docker/src/index.ts"),
      "@lite-harness/control-plane": source("./packages/control-plane/src/index.ts"),
      "@lite-harness/sdk": source("./packages/sdk-typescript/src/index.ts"),
      "@lite-harness/provider-core": source("./packages/provider-core/src/index.ts"),
      "@lite-harness/provider-openai-compatible": source("./packages/provider-openai-compatible/src/index.ts"),
      "@lite-harness/provider-anthropic": source("./packages/provider-anthropic/src/index.ts"),
      "@lite-harness/workspace": source("./packages/workspace/src/index.ts"),
      "@lite-harness/plugin-core": source("./packages/plugin-core/src/index.ts"),
      "@lite-harness/skills": source("./packages/skills/src/index.ts"),
      "@lite-harness/mcp": source("./packages/mcp/src/index.ts"),
      "@lite-harness/context": source("./packages/context/src/index.ts"),
      "@lite-harness/browser": source("./packages/browser/src/index.ts"),
      "@lite-harness/integrations": source("./packages/integrations/src/index.ts"),
      "@lite-harness/automation": source("./packages/automation/src/index.ts"),
      "@lite-harness/subagents": source("./packages/subagents/src/index.ts"),
      "@lite-harness/memory-sqlite": source("./packages/memory-sqlite/src/index.ts"),
      "@lite-harness/process-rpc": source("./packages/process-rpc/src/index.ts"),
      "@lite-harness/delegated-runtime": source("./packages/delegated-runtime/src/index.ts"),
      "@lite-harness/credential-store": source("./packages/credential-store/src/index.ts"),
      "@lite-harness/operations": source("./packages/operations/src/index.ts"),
      "@lite-harness/migration-openclaw": source("./packages/migration-openclaw/src/index.ts"),
      "@lite-harness/observability": source("./packages/observability/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: realRuntime ? realRuntimeFiles : liveHermes ? hermesFiles : ["test/**/*.test.ts"],
    exclude: realRuntime || liveHermes ? [] : [...realRuntimeOnlyFiles, ...hermesFiles],
    testTimeout: 15_000,
  },
});
