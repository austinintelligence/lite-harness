import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableSkillRunSnapshotStore, ImmutableSkillCatalog } from "@lite-harness/skills";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("immutable lazy skill lifecycle", () => {
  it("lists only manifests and loads an exact content-addressed body on demand", () => {
    const root = temporary("source");
    const snapshots = temporary("snapshots");
    const path = skill(root, "review", [
      "---", "name: review", "description: Review carefully", "source_version: 2.1.0",
      "tools: read_file", "permissions: network:none", "content_provenance: signed-pack", "---",
      "Original immutable instructions.", "",
    ].join("\n"));
    const catalog = new ImmutableSkillCatalog([
      { root, precedence: 10, source: "app", sourceVersion: "fallback" },
    ], { snapshotRoot: snapshots, protocolVersion: "1" });

    const listed = catalog.list({ allowedTools: new Set(["read_file"]), capabilities: new Set(), protocolVersion: "1" });
    expect(JSON.stringify(listed)).not.toContain("Original immutable instructions");
    expect(listed).toMatchObject([{
      name: "review", sourceVersion: "2.1.0", requestedTools: ["read_file"],
      permissionRequests: ["network:none"], contentProvenance: "signed-pack",
    }]);
    writeFileSync(path, "---\nname: review\ndescription: changed\n---\nTampered after startup.\n");
    const viewed = catalog.view("review", { allowedTools: new Set(["read_file"]), capabilities: new Set(), protocolVersion: "1" });
    expect(viewed?.body).toBe("Original immutable instructions.\n");
    expect(viewed?.contentDigest).toBe(listed[0]?.contentDigest);
    expect(catalog.snapshotForRun("run_one").skills).toEqual([{ name: "review", digest: listed[0]?.contentDigest }]);
  });

  it("enforces source-tier precedence and tool, capability, and protocol gates", () => {
    const builtin = temporary("builtin");
    const workspace = temporary("workspace");
    const snapshots = temporary("snapshots");
    skill(builtin, "deploy", "---\nname: deploy\ndescription: builtin\n---\nBuiltin\n");
    skill(workspace, "deploy", [
      "---", "name: deploy", "description: workspace", "tools: shell_exec",
      "capabilities: network", "protocol: 1", "---", "Workspace\n",
    ].join("\n"));
    const catalog = new ImmutableSkillCatalog([
      { root: builtin, precedence: 10_000, source: "builtin" },
      { root: workspace, precedence: -10_000, source: "workspace" },
    ], { snapshotRoot: snapshots, protocolVersion: "1" });
    expect(catalog.list()).toMatchObject([{ description: "workspace" }]);
    expect(catalog.list({ allowedTools: new Set(), capabilities: new Set(), protocolVersion: "1" })).toEqual([]);
    expect(catalog.list({ allowedTools: new Set(["shell_exec"]), capabilities: new Set(), protocolVersion: "1" })).toEqual([]);
    expect(catalog.view("deploy", {
      allowedTools: new Set(["shell_exec"]), capabilities: new Set(["network"]), protocolVersion: "2",
    })).toBeUndefined();
    expect(catalog.view("deploy", {
      allowedTools: new Set(["shell_exec"]), capabilities: new Set(["network"]), protocolVersion: "1",
    })?.body).toBe("Workspace\n");
  });

  it("bounds candidates before catalog construction", () => {
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
