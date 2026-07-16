import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCacheCatalog, type CacheDescriptor, type CachePublisher } from "@lite-harness/workspace";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("verified cache lifecycle BD-046-REGRESSION", () => {
  it("A13-CACHE-KEYS keys every compatibility and owner boundary deterministically", () => {
    const catalog = createCatalog();
    const descriptor = cache("workspace-private", "pnpm/store");
    const baseline = catalog.resolve(descriptor).key;
    expect(catalog.resolve({ ...descriptor, toolVersions: { pnpm: "11.0.0", node: "24.14.0" } }).key).toBe(baseline);
    const variants: CacheDescriptor[] = [
      { ...descriptor, kind: "dependency-tree" }, { ...descriptor, sourceDigest: "e".repeat(64) },
      { ...descriptor, lockDigest: "e".repeat(64) }, { ...descriptor, toolVersions: { node: "25" } },
      { ...descriptor, frameworkVersions: { next: "16" } }, { ...descriptor, runtimeVersion: "lite-runtime-v2" },
      { ...descriptor, imageDigest: `sha256:${"e".repeat(64)}` }, { ...descriptor, operatingSystem: "windows" },
      { ...descriptor, architecture: "arm64" }, { ...descriptor, configDigest: "e".repeat(64) },
      { ...descriptor, policyVersion: 2 }, { ...descriptor, tenantId: "other" }, { ...descriptor, workspaceId: "other" },
    ];
    expect(new Set(variants.map((entry) => catalog.resolve(entry).key)).size).toBe(variants.length);
    expect(variants.every((entry) => catalog.resolve(entry).key !== baseline)).toBe(true);
  });

  it("A13-CACHE-IMMUTABLE fences staged population and promotes a verified read-only generation", () => {
    const catalog = createCatalog();
    const descriptor = cache("global-immutable", "public/tool");
    expect(() => catalog.acquirePopulation(descriptor, publisher(false))).toThrow(/trusted publisher/);
    const first = catalog.acquirePopulation(descriptor, publisher(true));
    expect(() => catalog.acquirePopulation(descriptor, { ...publisher(true), id: "other" })).toThrow(/another publisher/);
    catalog.stageFile(first, "bin/tool.js", Buffer.from("version-one"));
    const replacement = catalog.acquirePopulation(descriptor, publisher(true));
    expect(() => catalog.stageFile(first, "stale.txt", Buffer.from("stale"))).toThrow(/stale or invalid/);
    catalog.stageFile(replacement, "bin/tool.js", Buffer.from("version-two"));
    const promoted = catalog.promote(replacement);
    expect(promoted).toMatchObject({ readOnly: true, fileCount: 1, sizeBytes: 11 });
    expect(readFileSync(join(promoted.path, "bin", "tool.js"), "utf8")).toBe("version-two");
    expect(catalog.resolve(descriptor).state).toBe("READY");
    const read = catalog.attachReadOnly(descriptor, {});
    expect(read).toMatchObject({ key: promoted.key, readOnly: true });
    catalog.releaseRead(read);
  });

  it("A13-CACHE-POISON enforces private scope and quarantines a modified generation", () => {
    const catalog = createCatalog();
    const descriptor = cache("workspace-private", "pnpm/store");
    const owner = publisher(false, "tenant", "workspace");
    const lease = catalog.acquirePopulation(descriptor, owner);
    catalog.stageFile(lease, "store/index.json", Buffer.from("{}"));
    const promoted = catalog.promote(lease);
    expect(() => catalog.attachReadOnly(descriptor, { tenantId: "other", workspaceId: "workspace" })).toThrow(/tenant scope/);
    const target = join(promoted.path, "store", "index.json");
    chmodSync(target, 0o600);
    writeFileSync(target, "tampered");
    expect(() => catalog.verify(promoted.key)).toThrow(/quarantined/);
    expect(catalog.resolve(descriptor).state).toBe("QUARANTINED");
    expect(() => catalog.attachReadOnly(descriptor, { tenantId: "tenant", workspaceId: "workspace" })).toThrow(/not ready/);
    expect(catalog.garbageCollect({ quotaBytes: Number.MAX_SAFE_INTEGER, maxEntries: Number.MAX_SAFE_INTEGER }).evictedEntries).toBe(1);
    expect(catalog.resolve(descriptor).state).toBe("MISSING");
  });

  it("A13-CACHE-EVICTION expires abandoned staging and applies lease-aware LRU quotas without evicting active readers", () => {
    const catalog = createCatalog();
    const firstDescriptor = cache("global-immutable", "one");
    const secondDescriptor = cache("global-immutable", "two");
    const abandoned = catalog.acquirePopulation(cache("global-immutable", "abandoned"), publisher(true), 1_000);
    catalog.stageFile(abandoned, "partial", Buffer.from("partial"));
    for (const [descriptor, content] of [[firstDescriptor, "first"], [secondDescriptor, "second"]] as const) {
      const lease = catalog.acquirePopulation(descriptor, publisher(true));
      catalog.stageFile(lease, "value", Buffer.from(content));
      catalog.promote(lease);
    }
    const active = catalog.attachReadOnly(firstDescriptor, {});
    const firstGc = catalog.garbageCollect({ quotaBytes: 0, maxEntries: 0, now: Date.now() + 2_000 });
    expect(firstGc).toMatchObject({ expiredPopulations: 1, evictedEntries: 1 });
    expect(catalog.resolve(firstDescriptor).state).toBe("READY");
    expect(catalog.resolve(secondDescriptor).state).toBe("MISSING");
    catalog.releaseRead(active);
    expect(catalog.garbageCollect({ quotaBytes: 0, maxEntries: 0 }).evictedEntries).toBe(1);
    expect(catalog.resolve(firstDescriptor).state).toBe("MISSING");
  });
});

function createCatalog(): LocalCacheCatalog {
  const root = mkdtempSync(join(tmpdir(), "lite-cache-lifecycle-")); cleanup.push(root);
  return new LocalCacheCatalog(root, { maxEntryBytes: 1024 * 1024, maxFiles: 100 });
}

function cache(kind: CacheDescriptor["class"], logicalKey: string): CacheDescriptor {
  return {
    class: kind, kind: "package-store", logicalKey, sourceDigest: "c".repeat(64),
    imageDigest: `sha256:${"a".repeat(64)}`, lockDigest: "b".repeat(64),
    toolVersions: { node: "24.14.0", pnpm: "11.0.0" }, frameworkVersions: {},
    runtimeVersion: "lite-runtime-v1", operatingSystem: "linux", architecture: "amd64",
    configDigest: "d".repeat(64), policyVersion: 1,
    ...(kind === "global-immutable" ? {} : { tenantId: "tenant" }),
    ...(kind === "workspace-private" ? { workspaceId: "workspace" } : {}),
  };
}

function publisher(trusted: boolean, tenantId?: string, workspaceId?: string): CachePublisher {
  return { id: "builder", trusted, provenance: "test-fixture", ...(tenantId ? { tenantId } : {}), ...(workspaceId ? { workspaceId } : {}) };
}
