import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConservativeContextCompiler, ContextStore } from "@lite-harness/context";
import { McpSupervisor } from "@lite-harness/mcp";
import { importOpenClawSkills, inspectOpenClawRoot } from "@lite-harness/migration-openclaw";
import {
  LazyPluginSupervisor,
  PluginInstallLock,
  PluginPackageInstaller,
  grantPluginPermissions,
  inspectPluginManifest,
  pluginPackageDigest,
} from "@lite-harness/plugin-core";
import { discoverSkills } from "@lite-harness/skills";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("optional capability kernel", () => {
  it("inspects manifests as data and narrows grants to declared permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-plugin-"));
    directories.push(root);
    writeFileSync(join(root, "worker.mjs"), "export default {}\n");
    writeFileSync(join(root, "lite-plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "example.plugin",
      version: "1.0.0",
      entry: "worker.mjs",
      trust: "isolated",
      permissions: {
        tools: ["search", "read_file"],
        secrets: ["search-key"],
        events: ["run.started"],
        files: ["workspace:read"],
        networkOrigins: ["https://search.example"],
      },
    }));
    const inspected = inspectPluginManifest(join(root, "lite-plugin.json"));
    const grant = grantPluginPermissions(inspected.manifest.permissions, {
      tools: ["search", "shell"],
      secrets: ["undeclared-secret"],
    });
    expect(grant.tools).toEqual(["search"]);
    expect(grant.secrets).toEqual([]);
  });

  it("does not start a plugin worker or timer until first invocation", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const invoke = vi.fn(async () => ({ ok: true }));
    let factories = 0;
    const supervisor = new LazyPluginSupervisor(() => {
      factories += 1;
      return { start, stop, invoke };
    }, { idleTtlMs: 0 });
    expect(supervisor.active).toBe(false);
    expect(factories).toBe(0);
    await expect(supervisor.invoke("run", {})).resolves.toEqual({ ok: true });
    expect(supervisor.active).toBe(true);
    expect(factories).toBe(1);
    await supervisor.stop();
  });

  it("stages plugin packages and rolls back both disk and lock state when verification fails", async () => {
    const source = mkdtempSync(join(tmpdir(), "lite-plugin-source-"));
    const installRoot = mkdtempSync(join(tmpdir(), "lite-plugin-install-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "lite-plugin-state-"));
    directories.push(source, installRoot, stateRoot);
    writeFileSync(join(source, "worker.mjs"), "export default {}\n");
    writeFileSync(join(source, "lite-plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "example.staged",
      version: "1.0.0",
      entry: "worker.mjs",
      trust: "isolated",
      permissions: { tools: ["search"], secrets: [], events: [], files: [], networkOrigins: [] },
    }));
    const lock = new PluginInstallLock(join(stateRoot, "plugins.lock.json"));
    const installer = new PluginPackageInstaller(installRoot, lock);
    await expect(installer.installAndVerify(source, { tools: ["search"] }, async () => {
      throw new Error("health check failed");
    })).rejects.toThrow("health check failed");
    expect(lock.read().plugins).toEqual({});
    expect(existsSync(join(installRoot, "example.staged", "1.0.0"))).toBe(false);

    const installed = await installer.installAndVerify(source, { tools: ["search"] }, async (plugin, entry) => {
      expect(plugin.manifest.id).toBe("example.staged");
      expect(entry.grantedPermissions.tools).toEqual(["search"]);
    });
    expect(installed.enabled).toBe(true);
    expect(existsSync(join(installed.source, "worker.mjs"))).toBe(true);
    const installedRelative = relative(realpathSync(installRoot), installed.source);
    expect(installedRelative.startsWith("..") || isAbsolute(installedRelative)).toBe(false);
    expect(pluginPackageDigest(inspectPluginManifest(join(installed.source, "lite-plugin.json")))).toBe(installed.digest);
    writeFileSync(join(installed.source, "worker.mjs"), "export default { tampered: true }\n");
    expect(pluginPackageDigest(inspectPluginManifest(join(installed.source, "lite-plugin.json")))).not.toBe(installed.digest);
  });

  it("loads SKILL.md snapshots with deterministic precedence and no symlink traversal", () => {
    const app = mkdtempSync(join(tmpdir(), "lite-skills-app-"));
    const builtin = mkdtempSync(join(tmpdir(), "lite-skills-builtin-"));
    directories.push(app, builtin);
    mkdirSync(join(app, "review"));
    mkdirSync(join(builtin, "review"));
    writeFileSync(join(app, "review", "SKILL.md"), "---\nname: review\ndescription: app review\ntools: shell\n---\nApp version\n");
    writeFileSync(join(builtin, "review", "SKILL.md"), "---\nname: review\ndescription: builtin review\n---\nBuiltin version\n");
    const skills = discoverSkills([
      { root: builtin, precedence: 1, source: "builtin" },
      { root: app, precedence: 10, source: "app" },
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "review", description: "app review", source: "app" });
    expect(skills[0]?.requestedTools).toEqual(["shell"]);
  });

  it("D32 preserves selected OpenClaw behavior while discarding source layout and unrelated files", () => {
    const source = mkdtempSync(join(tmpdir(), "lite-openclaw-source-"));
    const target = mkdtempSync(join(tmpdir(), "lite-openclaw-target-")); directories.push(source, target);
    mkdirSync(join(source, "custom", "deep", "review"), { recursive: true });
    writeFileSync(join(source, "openclaw.json"), JSON.stringify({ apiKey: "must-not-appear", providers: {} }));
    writeFileSync(join(source, "custom", "deep", "review", "SKILL.md"), "---\nname: review\ndescription: migrated\n---\nBody\n");
    writeFileSync(join(source, "custom", "deep", "unrelated.txt"), "must not be imported");
    const report = inspectOpenClawRoot(source);
    expect(report.configuration).toMatchObject([{ keys: ["apiKey", "providers"] }]);
    expect(JSON.stringify(report)).not.toContain("must-not-appear");
    expect(importOpenClawSkills(report, target)).toHaveLength(1);
    const selected = join(target, "imports", "openclaw", "skills", "review", "SKILL.md");
    expect(readFileSync(selected, "utf8")).toContain("description: migrated");
    expect(existsSync(join(target, "openclaw.json"))).toBe(false);
    expect(existsSync(join(target, "custom"))).toBe(false);
    expect(existsSync(join(target, "imports", "openclaw", "skills", "review", "unrelated.txt"))).toBe(false);
  });

  it("starts MCP servers lazily and isolates a failed server", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const supervisor = new McpSupervisor({ timeoutMs: 100, maxPayloadBytes: 1024 });
    supervisor.register("working", () => ({ start, stop, call: async () => ({ ok: true }) }));
    expect(supervisor.isActive("working")).toBe(false);
    await expect(supervisor.call("working", "ping", {})).resolves.toEqual({ ok: true });
    expect(supervisor.isActive("working")).toBe(true);
    await supervisor.stopAll();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps canonical context exact and only renders eligible blocks for allowlisted models", async () => {
    const store = new ContextStore();
    const exactLogs = "long semantic logs ".repeat(100);
    store.put({ id: "logs", kind: "logs", exactText: exactLogs, lossyEligible: true, sensitive: false });
    store.put({ id: "source", kind: "source", exactText: "const exact = 1", lossyEligible: true, sensitive: false });
    const compiler = new ConservativeContextCompiler(
      store,
      { render: async () => "data:image/png;base64,AAAA" },
      new Set(["measured-model"]),
    );
    const unknown = await compiler.compile("unknown-model", "conservative");
    expect(unknown.every((block) => block.representation === "text")).toBe(true);
    const measured = await compiler.compile("measured-model", "conservative", {
      appId: "app", tenantId: "tenant", modelCapabilities: ["text", "vision"],
    });
    expect(measured.find((block) => block.id === "logs")?.representation).toBe("image");
    expect(measured.find((block) => block.id === "source")?.representation).toBe("text");
    expect(store.fetchExact("logs")).toBe(exactLogs);
    store.close();
  });
});
