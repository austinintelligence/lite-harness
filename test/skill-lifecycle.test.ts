import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableSkillRunSnapshotStore, ImmutableSkillCatalog } from "@lite-harness/skills";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("immutable lazy skill lifecycle BD-044-REGRESSION", () => {
  it("A19-IMMUTABLE-SNAPSHOT lists only deterministic manifests and loads an exact content-addressed body on demand", () => {
    const root = temporary("source");
    const mirror = temporary("mirror");
    const snapshots = temporary("snapshots");
    const original = [
      "---", "name: review", "description: Review carefully", "source_version: 2.1.0",
      "tools: read_file", "permissions: network:none", "content_provenance: signed-pack", "---",
      "Original immutable instructions.", "",
    ].join("\n");
    const path = skill(root, "review", original);
    skill(mirror, "review", original);
    const catalog = new ImmutableSkillCatalog([
      { root, precedence: 10, source: "app", sourceVersion: "fallback" },
    ], { snapshotRoot: snapshots, protocolVersion: "1" });
    const mirrorCatalog = new ImmutableSkillCatalog([
      { root: mirror, precedence: 10, source: "app", sourceVersion: "fallback" },
    ], { snapshotRoot: temporary("mirror-snapshots"), protocolVersion: "1" });
    const reopenedCatalog = new ImmutableSkillCatalog([
      { root, precedence: 10, source: "app", sourceVersion: "fallback" },
    ], { snapshotRoot: snapshots, protocolVersion: "1" });

    const listed = catalog.list({ allowedTools: new Set(["read_file"]), capabilities: new Set(), protocolVersion: "1" });
    expect(JSON.stringify(listed)).not.toContain("Original immutable instructions");
    expect(listed).toMatchObject([{
      name: "review", sourceVersion: "2.1.0", requestedTools: ["read_file"],
      permissionRequests: ["network:none"], contentProvenance: "signed-pack",
    }]);
    expect(mirrorCatalog.generation).toBe(catalog.generation);
    expect(reopenedCatalog.generation).toBe(catalog.generation);
    expect(mirrorCatalog.list()[0]?.contentDigest).toBe(listed[0]?.contentDigest);
    writeFileSync(path, "---\nname: review\ndescription: changed\n---\nTampered after startup.\n");
    const viewed = catalog.view("review", { allowedTools: new Set(["read_file"]), capabilities: new Set(), protocolVersion: "1" });
    expect(viewed?.body).toBe("Original immutable instructions.\n");
    expect(viewed?.contentDigest).toBe(listed[0]?.contentDigest);
    expect(catalog.snapshotForRun("run_one").skills).toEqual([{ name: "review", digest: listed[0]?.contentDigest }]);
  });

  it("A19-PRECEDENCE-GATES enforces source-tier precedence plus visibility, tool, capability, and protocol gates", () => {
    const builtin = temporary("builtin");
    const installed = temporary("installed");
    const app = temporary("app");
    const user = temporary("user");
    const workspace = temporary("workspace");
    const pinned = temporary("pinned");
    const snapshots = temporary("snapshots");
    skill(builtin, "deploy", "---\nname: deploy\ndescription: builtin\n---\nBuiltin\n");
    skill(installed, "deploy", "---\nname: deploy\ndescription: installed\n---\nInstalled\n");
    skill(app, "deploy", "---\nname: deploy\ndescription: app\n---\nApp\n");
    skill(user, "deploy", "---\nname: deploy\ndescription: user\n---\nUser\n");
    skill(workspace, "deploy", "---\nname: deploy\ndescription: workspace\n---\nWorkspace\n");
    skill(pinned, "deploy", [
      "---", "name: deploy", "description: pinned", "tools: shell_exec",
      "capabilities: network", "protocol: 1", "---", "Pinned\n",
    ].join("\n"));
    skill(app, "same-tier", "---\nname: same-tier\ndescription: app lower\n---\nApp lower\n");
    skill(user, "same-tier", "---\nname: same-tier\ndescription: user higher\n---\nUser higher\n");
    const catalog = new ImmutableSkillCatalog([
      { root: builtin, precedence: 10_000, source: "builtin" },
      { root: installed, precedence: 10_000, source: "installed-pack" },
      { root: app, precedence: 1, source: "app" },
      { root: user, precedence: 2, source: "user" },
      { root: workspace, precedence: -10_000, source: "workspace" },
      { root: pinned, precedence: -10_000, source: "run-pinned", visibilityScope: "tenant:one" },
    ], { snapshotRoot: snapshots, protocolVersion: "1" });
    expect(catalog.list()).toMatchObject([
      { name: "deploy", description: "pinned", source: "run-pinned" },
      { name: "same-tier", description: "user higher", source: "user" },
    ]);
    expect(catalog.view("deploy", {
      allowedTools: new Set(["shell_exec"]), capabilities: new Set(["network"]), protocolVersion: "1",
      visibilityScopes: new Set(["tenant:other"]),
    })).toBeUndefined();
    expect(catalog.view("deploy", {
      allowedTools: new Set(), capabilities: new Set(["network"]), protocolVersion: "1",
      visibilityScopes: new Set(["tenant:one"]),
    })).toBeUndefined();
    expect(catalog.view("deploy", {
      allowedTools: new Set(["shell_exec"]), capabilities: new Set(), protocolVersion: "1",
      visibilityScopes: new Set(["tenant:one"]),
    })).toBeUndefined();
    expect(catalog.view("deploy", {
      allowedTools: new Set(["shell_exec"]), capabilities: new Set(["network"]), protocolVersion: "2",
      visibilityScopes: new Set(["tenant:one"]),
    })).toBeUndefined();
    expect(catalog.view("deploy", {
      allowedTools: new Set(["shell_exec"]), capabilities: new Set(["network"]), protocolVersion: "1",
      visibilityScopes: new Set(["tenant:one"]),
    })?.body).toBe("Pinned\n");
  });

  it("A19-FILESYSTEM-SAFETY ignores linked escapes and retains only in-root deterministic paths", () => {
    const root = temporary("linked-root");
    const outside = temporary("linked-outside");
    skill(root, "safe", "---\nname: safe\ndescription: in root\n---\nSafe\n");
    skill(outside, "escaped", "---\nname: escaped\ndescription: outside\n---\nMust not load\n");
    symlinkSync(join(outside, "escaped"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const catalog = new ImmutableSkillCatalog([
      { root, precedence: 1, source: "app" },
    ], { snapshotRoot: temporary("linked-snapshots"), maxDepth: 4 });
    expect(catalog.list().map((entry) => entry.name)).toEqual(["safe"]);
    expect(catalog.list().every((entry) => !entry.relativePath.startsWith("..") && !entry.relativePath.includes("\\"))).toBe(true);

    const hardlinkRoot = temporary("hardlink-root");
    const hardlinkOutside = temporary("hardlink-outside");
    const outsidePath = skill(hardlinkOutside, "outside", "---\nname: outside\ndescription: outside inode\n---\nOUTSIDE-SENTINEL\n");
    mkdirSync(join(hardlinkRoot, "imported"), { recursive: true });
    linkSync(outsidePath, join(hardlinkRoot, "imported", "SKILL.md"));
    expect(() => new ImmutableSkillCatalog([
      { root: hardlinkRoot, precedence: 1, source: "workspace" },
    ], { snapshotRoot: temporary("hardlink-snapshots") })).toThrow(/stable single-link regular file/);
  });

  it("A19-LIMITS enforces depth, byte, frontmatter, prompt, and candidate limits", () => {
    const deep = temporary("deep");
    skill(deep, "one/two/three", "---\nname: deep\ndescription: too deep\n---\nDeep\n");
    const depthBound = new ImmutableSkillCatalog([
      { root: deep, precedence: 1, source: "builtin" },
    ], { snapshotRoot: temporary("deep-snapshots"), maxDepth: 1 });
    expect(depthBound.list()).toEqual([]);

    const bytes = temporary("bytes");
    skill(bytes, "large", `---\nname: large\ndescription: large\n---\n${"x".repeat(128)}\n`);
    expect(() => new ImmutableSkillCatalog([
      { root: bytes, precedence: 1, source: "builtin" },
    ], { snapshotRoot: temporary("bytes-snapshots"), maxBytes: 64 })).toThrow(/exceeds 64 bytes/);

    const frontmatter = temporary("frontmatter");
    skill(frontmatter, "large-header", `---\nname: header\ndescription: ${"x".repeat(64)}\n---\nBody\n`);
    expect(() => new ImmutableSkillCatalog([
      { root: frontmatter, precedence: 1, source: "builtin" },
    ], { snapshotRoot: temporary("frontmatter-snapshots"), maxFrontmatterBytes: 32 })).toThrow(/frontmatter.*exceeds 32 bytes/i);

    const prompt = temporary("prompt");
    skill(prompt, "long-prompt", "---\nname: prompt\ndescription: prompt\n---\n123456789\n");
    const promptBound = new ImmutableSkillCatalog([
      { root: prompt, precedence: 1, source: "builtin" },
    ], { snapshotRoot: temporary("prompt-snapshots"), maxPromptCharacters: 8 });
    expect(() => promptBound.view("prompt")).toThrow(/prompt exceeds 8 characters/);

    const root = temporary("bounded");
    const snapshots = temporary("snapshots");
    skill(root, "one", "---\nname: one\ndescription: one\n---\none\n");
    skill(root, "two", "---\nname: two\ndescription: two\n---\ntwo\n");
    expect(() => new ImmutableSkillCatalog([
      { root, precedence: 1, source: "builtin" },
    ], { snapshotRoot: snapshots, maxCandidates: 1 })).toThrow(/exceeds 1 candidates/);
  });

  it("durably binds one immutable digest set to each owned run", () => {
    const root = temporary("durable");
    const store = new DurableSkillRunSnapshotStore(join(root, "skills.sqlite"));
    const snapshot = {
      runId: "run_one", appId: "app", tenantId: "tenant", userId: "user", workspaceId: "workspace",
      generation: "a".repeat(64), skills: [{ name: "review", digest: "b".repeat(64) }],
    };
    expect(store.record(snapshot)).toMatchObject(snapshot);
    expect(store.record(snapshot)).toMatchObject(snapshot);
    expect(store.get("run_one", { appId: "app", tenantId: "other", userId: "user" })).toBeUndefined();
    expect(() => store.record({ ...snapshot, generation: "c".repeat(64) })).toThrow(/changed for run/);
    store.close();
  });
});

function temporary(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `lite-skill-${label}-`)); cleanup.push(path); return path;
}

function skill(root: string, name: string, content: string): string {
  const directory = join(root, name); mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md"); writeFileSync(path, content); return path;
}
