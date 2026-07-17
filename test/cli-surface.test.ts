import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("CLI alpha surface", () => {
  it("cli-local-init-config creates durable installation state and prints the credential once", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-cli-surface-"));
    roots.push(root);
    const first = runCli(root, "init");
    expect(first).toMatchObject({ initialized: true, defaultAgentId: "default", defaultWorkspaceId: "default" });
    expect(typeof first.clientCredential).toBe("string");

    const second = runCli(root, "init");
    expect(second).toMatchObject({ initialized: true, clientCredential: null, clientCredentialAlreadyExists: true });
    expect(runCli(root, "config", "validate")).toMatchObject({ valid: true, dataDir: root });
    expect(runCli(root, "config", "get", "LITE_HARNESS_PROVIDER")).toMatchObject({ name: "LITE_HARNESS_PROVIDER", value: "fake" });
  });

  it("cli-surface-route-aliases keeps the frozen command aliases mapped to real internal routes", () => {
    const cli = readFileSync(join(process.cwd(), "apps", "cli", "src", "main.ts"), "utf8");
    const manager = readFileSync(join(process.cwd(), "apps", "manager", "src", "server.ts"), "utf8");
    for (const token of [
      "agent", "show", "delete", "workspace", "export", "import", "run", "events", "watch",
      "approve", "reject", "provider", "models", "plugin", "upgrade", "LITE_HARNESS_DATA_DIR",
    ]) expect(cli).toContain(token);
    expect(manager).toContain('app.delete<{ Params: { agentId: string } }>("/internal/agents/:agentId"');
    expect(manager).toContain('"/internal/runs"');
  });
});

function runCli(dataDir: string, ...args: string[]): Record<string, any> {
  const output = execFileSync(process.execPath, ["--import", "tsx", "apps/cli/src/main.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LITE_HARNESS_DATA_DIR: dataDir,
      LITE_HARNESS_MODE: "development",
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_CREDENTIAL_RECOVERY_KEY: "ci-only-lite-harness-recovery-key",
    },
    encoding: "utf8",
  });
  return JSON.parse(output);
}
