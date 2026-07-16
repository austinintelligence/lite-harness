import { createHook } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { BrokeredToolRuntime, InMemoryToolRuntime } from "@lite-harness/runtime";
import { configureProductionOptionalSystems } from "../apps/manager/src/optional-systems.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("disabled optional packs", () => {
  it("A22-DISABLED-ZERO-RESOURCES D24 BD-049-REGRESSION keeps removable capability packs lazy and creates zero resources while disabled", async () => {
    const resources = trackWatchedResources();
    const parent = mkdtempSync(join(tmpdir(), "lite-disabled-packs-")); roots.push(parent);
    const dataDir = join(parent, "must-not-be-created");
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    let systems: Awaited<ReturnType<typeof configureProductionOptionalSystems>> | undefined;
    try {
      systems = await configureProductionOptionalSystems({ dataDir, modelId: "model", runtime, environment: {} });
      await new Promise<void>((resolveDone) => setImmediate(resolveDone));
      expect(resources.counts()).toEqual({});
    } finally { resources.stop(); }
    expect(runtime.listTools().map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
    expect(systems?.context).toBeUndefined(); expect(systems?.workspaceLifecycle).toBeUndefined(); expect(systems?.plugins).toEqual([]);
    expect(existsSync(dataDir)).toBe(false);
    await systems?.stop();

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

  it("A22-PRELOADED-OFFLINE-FAKE completes locally without a pull or outbound request and returns to its resource baseline", async () => {
    const resources = trackWatchedResources();
    const fetch = vi.fn(async () => { throw new Error("offline fake run attempted outbound fetch"); });
    vi.stubGlobal("fetch", fetch);
    const runtime = new InMemoryToolRuntime();
    try {
      await new AgentRunner(new FakeModelGateway(), runtime, 4).run({
        input: "create the offline fixture", workspaceId: "offline-workspace", allowedTools: ["write_file"],
        onEvent: () => undefined,
      });
      await new Promise<void>((resolveDone) => setImmediate(resolveDone));
      expect(resources.counts()).toEqual({});
    } finally { resources.stop(); }
    expect(runtime.readFile("offline-workspace", "hello.txt")).toContain("Lite-Harness completed");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function trackWatchedResources(): { counts(): Record<string, number>; stop(): void } {
  const normalizedTypes = new Map([
    ["WORKER", "Worker"], ["Worker", "Worker"],
    ["MESSAGEPORT", "MessagePort"], ["MessagePort", "MessagePort"],
    ["TCPSERVERWRAP", "TCPSERVERWRAP"], ["TCPWRAP", "TCPWRAP"],
    ["UDPWRAP", "UDPSocket"], ["UDPSocket", "UDPSocket"],
    ["Timeout", "Timeout"], ["TIMERWRAP", "Timeout"],
  ]);
  const live = new Map<number, string>();
  const hook = createHook({
    init(asyncId, type) {
      const normalized = normalizedTypes.get(type);
      if (normalized) live.set(asyncId, normalized);
    },
    destroy(asyncId) { live.delete(asyncId); },
  });
  hook.enable();
  return {
    counts: () => [...live.values()].reduce<Record<string, number>>((counts, resource) => {
      counts[resource] = (counts[resource] ?? 0) + 1;
      return counts;
    }, {}),
    stop: () => hook.disable(),
  };
}
