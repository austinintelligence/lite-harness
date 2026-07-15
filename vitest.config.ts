import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

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
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
