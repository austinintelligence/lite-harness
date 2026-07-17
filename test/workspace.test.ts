import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalArtifactStore,
  LocalCacheCatalog,
  LocalWorkspaceSnapshotStore,
  DerivedSnapshotKeyProvider,
  rejectSensitiveRegisteredRoot,
  StaticSnapshotKeyProvider,
  validateRegisteredBindRoot,
} from "@lite-harness/workspace";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workspace durability", () => {
  it("derives different stable snapshot keys for different workspace identities", async () => {
    const provider = new DerivedSnapshotKeyProvider(Buffer.alloc(32, 7));
    const first = await provider.getKey("workspace-a");
    const second = await provider.getKey("workspace-b");
    const repeat = await provider.getKey("workspace-a");
    expect(first).not.toEqual(second);
    expect(first).toEqual(repeat);
  });

  it("restores pre-derived-key snapshots through the explicit legacy static-key fallback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-snapshot-upgrade-"));
    directories.push(directory);
    const rootKey = Buffer.alloc(32, 6);
    const legacyStaticKey = { getKey: async (_workspaceId: string) => Buffer.from(rootKey) };
    const legacy = new LocalWorkspaceSnapshotStore(directory, legacyStaticKey);
    await legacy.create("workspace-upgrade", Buffer.from("legacy archive"));

    const upgraded = new LocalWorkspaceSnapshotStore(
      directory,
      new DerivedSnapshotKeyProvider(rootKey),
      new StaticSnapshotKeyProvider(rootKey),
    );
    await expect(upgraded.restore("workspace-upgrade")).resolves.toMatchObject({
      archive: Buffer.from("legacy archive"), recoveredFromPrevious: false,
    });
  });

  it("BD-034-REGRESSION rejects sensitive registered bind roots with portable rules", () => {
    for (const [path, home] of [
      ["/", "/home/alice"],
      ["/home/alice", "/home/alice"],
      ["/etc/project", "/home/alice"],
      ["/home/alice/.ssh/project", "/home/alice"],
      ["C:\\", "C:\\Users\\Alice"],
      ["C:\\Users\\Alice", "C:\\Users\\Alice"],
      ["C:\\Windows\\Temp\\project", "C:\\Users\\Alice"],
      ["C:\\Users\\Alice\\AppData\\Local\\project", "C:\\Users\\Alice"],
    ] as const) {
      expect(() => rejectSensitiveRegisteredRoot(path, home)).toThrow(/filesystem root|whole user home|sensitive/);
    }
    expect(() => rejectSensitiveRegisteredRoot("/home/alice/project", "/home/alice")).not.toThrow();
    expect(() => rejectSensitiveRegisteredRoot("C:\\Users\\Alice\\project", "C:\\Users\\Alice")).not.toThrow();

    const directory = mkdtempSync(join(tmpdir(), "lite-registered-bind-"));
    directories.push(directory);
    expect(validateRegisteredBindRoot(directory)).toBe(directory);
    const target = join(directory, "project");
    const link = join(directory, "project-link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(validateRegisteredBindRoot(link)).toBe(target);
  });

  it("encrypts snapshots and falls back to the previous verified generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-snapshot-"));
    directories.push(directory);
    const store = new LocalWorkspaceSnapshotStore(
      directory,
      new StaticSnapshotKeyProvider(Buffer.alloc(32, 7)),
    );
    const first = await store.create("workspace-1", Buffer.from("first archive"));
    const second = await store.create("workspace-1", Buffer.from("second archive"));
    expect(readFileSync(second.path, "utf8")).not.toContain("second archive");

    const encoded = readFileSync(second.path);
    encoded[encoded.length - 1] = (encoded.at(-1) ?? 0) ^ 0xff;
    writeFileSync(second.path, encoded);

    const restored = await store.restore("workspace-1");
    expect(restored.recoveredFromPrevious).toBe(true);
    expect(restored.archive.toString("utf8")).toBe("first archive");
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("BD-015-REGRESSION authenticates workspace identity metadata as AEAD associated data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-snapshot-identity-"));
    directories.push(directory);
    const store = new LocalWorkspaceSnapshotStore(directory, new StaticSnapshotKeyProvider(Buffer.alloc(32, 7)));
    const source = await store.create("workspace-a", Buffer.from("private-a"));
    const target = await store.create("workspace-b", Buffer.from("private-b"));
    const encoded = readFileSync(source.path);
    const firstNewline = encoded.indexOf(0x0a);
    const secondNewline = encoded.indexOf(0x0a, firstNewline + 1);
    const header = JSON.parse(encoded.subarray(firstNewline + 1, secondNewline).toString("utf8")) as Record<string, unknown>;
    header.workspaceId = "workspace-b";
    const forged = Buffer.concat([
      encoded.subarray(0, firstNewline + 1),
      Buffer.from(`${JSON.stringify(header)}\n`),
      encoded.subarray(secondNewline + 1),
    ]);
    writeFileSync(target.path, forged);
    await expect(store.restore("workspace-b")).rejects.toThrow(/No valid snapshot/);
  });

  it("BD-016-REGRESSION never rotates a corrupt current generation over previous-good", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-snapshot-rotation-"));
    directories.push(directory);
    const store = new LocalWorkspaceSnapshotStore(directory, new StaticSnapshotKeyProvider(Buffer.alloc(32, 8)));
    await store.create("workspace", Buffer.from("previous-good"));
    const corrupt = await store.create("workspace", Buffer.from("will-corrupt"));
    const corruptBytes = readFileSync(corrupt.path);
    corruptBytes[corruptBytes.length - 1] ^= 0xff;
    writeFileSync(corrupt.path, corruptBytes);

    const newest = await store.create("workspace", Buffer.from("new-current"));
    const newestBytes = readFileSync(newest.path);
    newestBytes[newestBytes.length - 1] ^= 0xff;
    writeFileSync(newest.path, newestBytes);
    const restored = await store.restore("workspace");
    expect(restored.recoveredFromPrevious).toBe(true);
    expect(restored.archive.toString("utf8")).toBe("previous-good");
  });

  it("BD-017-REGRESSION yields the event loop while streaming snapshot compression and encryption", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-snapshot-stream-"));
    directories.push(directory);
    const store = new LocalWorkspaceSnapshotStore(directory, new StaticSnapshotKeyProvider(Buffer.alloc(32, 9)));
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    await store.create("workspace", randomBytes(8 * 1024 * 1024));
    clearTimeout(timer);
    expect(timerFired).toBe(true);
  });

  it("binds artifact downloads to app, tenant, and user ownership", () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-artifact-"));
    directories.push(directory);
    const store = new LocalArtifactStore(directory, Buffer.alloc(32, 4));
    const principal = {
      appId: "app-1",
      tenantId: "tenant-1",
      userId: "user-1",
      scopes: ["artifacts:write", "artifacts:read"],
    };
    const record = store.publish({
      runId: "run-1",
      workspaceId: "workspace-1",
      principal,
      path: "output/report.txt",
      mediaType: "text/plain",
      data: Buffer.from("private result"),
    });
    expect(store.get(record.id, principal)?.data.toString("utf8")).toBe("private result");
    expect(store.get(record.id, { ...principal, tenantId: "tenant-other" })).toBeUndefined();
    const blobPath = join(directory, "blobs", record.id.slice(4, 6), record.id, "artifact.lha");
    expect(readFileSync(blobPath, "utf8")).not.toContain("private result");
    expect(existsSync(join(directory, "artifacts.sqlite"))).toBe(true);
    const tampered = readFileSync(blobPath);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(blobPath, tampered);
    expect(() => store.get(record.id, principal)).toThrow(/integrity check failed/);
  });

  it("rejects unsafe artifact paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-artifact-"));
    directories.push(directory);
    const store = new LocalArtifactStore(directory, Buffer.alloc(32, 4));
    expect(() => store.publish({
      runId: "run-1",
      workspaceId: "workspace-1",
      principal: { appId: "app-1", tenantId: "tenant-1", userId: "user-1", scopes: [] },
      path: "../escape.txt",
      mediaType: "text/plain",
      data: Buffer.from("no"),
    })).toThrow(/Unsafe workspace path/);
  });

  it("keys private caches by tenant and workspace while requiring immutable runtime inputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-cache-")); directories.push(directory);
    const catalog = new LocalCacheCatalog(directory);
    const base = { class: "workspace-private" as const, kind: "package-store", logicalKey: "pnpm/store",
      sourceDigest: "c".repeat(64), imageDigest: `sha256:${"a".repeat(64)}`, lockDigest: "b".repeat(64),
      toolVersions: { node: "24.14.0", pnpm: "11.0.0" }, frameworkVersions: {}, runtimeVersion: "lite-runtime-v1",
      operatingSystem: "linux", architecture: "amd64", configDigest: "d".repeat(64), policyVersion: 1, workspaceId: "workspace" };
    const first = catalog.resolve({ ...base, tenantId: "tenant-one" });
    const second = catalog.resolve({ ...base, tenantId: "tenant-two" });
    expect(first.key).not.toBe(second.key);
    expect(() => catalog.resolve({ ...base, tenantId: "tenant", imageDigest: "latest" })).toThrow(/immutable/);
  });
});
