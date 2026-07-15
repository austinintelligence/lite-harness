import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalArtifactStore,
  LocalCacheCatalog,
  LocalWorkspaceSnapshotStore,
  StaticSnapshotKeyProvider,
} from "@lite-harness/workspace";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workspace durability", () => {
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
    const store = new LocalArtifactStore(directory);
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
  });

  it("rejects unsafe artifact paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-artifact-"));
    directories.push(directory);
    const store = new LocalArtifactStore(directory);
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
    const base = { class: "workspace-private" as const, logicalKey: "pnpm/store", imageDigest: `sha256:${"a".repeat(64)}`,
      toolchain: "node-24-pnpm-11", lockDigest: "b".repeat(64), workspaceId: "workspace" };
    const first = catalog.resolve({ ...base, tenantId: "tenant-one" });
    const second = catalog.resolve({ ...base, tenantId: "tenant-two" });
    expect(first.key).not.toBe(second.key);
    expect(() => catalog.resolve({ ...base, tenantId: "tenant", imageDigest: "latest" })).toThrow(/immutable/);
  });
});
