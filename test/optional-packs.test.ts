import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokeredToolRuntime, InMemoryToolRuntime } from "@lite-harness/runtime";
import { configureProductionOptionalSystems } from "../apps/manager/src/optional-systems.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("disabled optional packs", () => {
  it("BD-049-REGRESSION creates zero resources, schemas, storage, or eager pack imports", async () => {
    const disabledPackResourceProbe = () => resourceCounts(process.getActiveResourcesInfo());
    const before = disabledPackResourceProbe();
    const parent = mkdtempSync(join(tmpdir(), "lite-disabled-packs-")); roots.push(parent);
    const dataDir = join(parent, "must-not-be-created");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const systems = await configureProductionOptionalSystems({ dataDir, modelId: "model", runtime, environment: {} });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(runtime.listTools().map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
    expect(systems.context).toBeUndefined(); expect(systems.workspaceLifecycle).toBeUndefined(); expect(systems.plugins).toEqual([]);
    expect(existsSync(dataDir)).toBe(false);
    expect(disabledPackResourceProbe()).toEqual(before);
    await systems.stop();

    for (const path of ["apps/manager/src/main.ts", "apps/manager/src/optional-systems.ts"]) {
      const source = readFileSync(resolve(path), "utf8");
      const imports = source.match(/^import[\s\S]*?;\r?$/gm) ?? [];
      const eagerPacks = imports.filter((statement) => !/^import\s+type\b/.test(statement) && /["']@lite-harness\/(?:automation|browser|context|integrations|mcp|memory-sqlite|plugin-core|skills)["']/.test(statement));
      expect(eagerPacks).toEqual([]);
    }
    const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    expect(Object.keys(rootPackage.dependencies ?? {})).not.toEqual(expect.arrayContaining(["pxpipe-proxy"]));
    expect(rootPackage.optionalDependencies).toMatchObject({ "pxpipe-proxy": "0.8.0" });
  });
});

function resourceCounts(resources: string[]): Record<string, number> {
  const watched = new Set(["Worker", "MessagePort", "TCPSERVERWRAP", "TCPWRAP", "UDPSocket", "Timeout"]);
  return resources.filter((resource) => watched.has(resource)).reduce<Record<string, number>>((counts, resource) => {
    counts[resource] = (counts[resource] ?? 0) + 1; return counts;
  }, {});
}
