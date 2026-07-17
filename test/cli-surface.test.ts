import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

  it("A15-RECOVERY-BUNDLE-CLI exports and imports a clean encrypted installation", () => {
    const source = mkdtempSync(join(tmpdir(), "lite-cli-recovery-source-"));
    const targetParent = mkdtempSync(join(tmpdir(), "lite-cli-recovery-target-"));
    roots.push(source, targetParent);
    const keyFile = join(source, "recovery-key.txt");
    writeFileSync(keyFile, Buffer.alloc(32, 23).toString("base64"), { mode: 0o600 });
    expect(runCli(source, "init")).toMatchObject({ initialized: true });
    writeFileSync(join(source, "durable-marker.txt"), "authoritative");
    const bundle = join(source, "installation.lhr");
    expect(runCli(source, "recovery", "export", bundle, keyFile)).toMatchObject({ exported: true, encrypted: true });
    const target = join(targetParent, "restored");
    expect(runCli(source, "recovery", "import", bundle, target, keyFile)).toMatchObject({ imported: true, entries: expect.any(Number) });
    expect(readFileSync(join(target, "durable-marker.txt"), "utf8")).toBe("authoritative");
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
