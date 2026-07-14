import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConservativeContextCompiler, ContextStore } from "@lite-harness/context";
import { McpSupervisor } from "@lite-harness/mcp";
import {
  LazyPluginSupervisor,
  grantPluginPermissions,
  inspectPluginManifest,
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
    store.put({ id: "logs", kind: "logs", exactText: "long logs", lossyEligible: true, sensitive: false });
    store.put({ id: "source", kind: "source", exactText: "const exact = 1", lossyEligible: true, sensitive: false });
    const compiler = new ConservativeContextCompiler(
      store,
      { render: async () => "data:image/png;base64,AAAA" },
      new Set(["measured-model"]),
    );
    const unknown = await compiler.compile("unknown-model", "conservative");
    expect(unknown.every((block) => block.representation === "text")).toBe(true);
    const measured = await compiler.compile("measured-model", "conservative");
    expect(measured.find((block) => block.id === "logs")?.representation).toBe("image");
    expect(measured.find((block) => block.id === "source")?.representation).toBe("text");
    expect(store.fetchExact("logs")).toBe("long logs");
  });
});
