import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerBrowserDriver,
  DurableBrowserSessionStore,
  ManagedBrowserBroker,
  reconcileBrowserResources,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserDriver,
  type BrowserNetworkPolicy,
  type BrowserProcessFactory,
} from "@lite-harness/browser";
import { LocalArtifactStore } from "@lite-harness/workspace";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable browser sessions and artifact quarantine BD-043-REGRESSION", () => {
  it("persists owner-scoped actions and reconciles interrupted sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-browser-durable-")); cleanup.push(directory);
    const databasePath = join(directory, "browser.sqlite");
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run" };
    let store = new DurableBrowserSessionStore(databasePath);
    const broker = new ManagedBrowserBroker(() => new FakeDriver(), { durabilityStore: store, idleTtlMs: 60_000 });
    const sessionId = broker.create(owner, { allowedOrigins: ["https://example.com"] }, "default");
    await broker.execute(sessionId, owner, { action: "snapshot" });
    broker.recordArtifact(sessionId, owner, "art_00000000000000000000000000000000", "DOWNLOAD");
    expect(store.listActions(sessionId, owner)).toMatchObject([{ action: "snapshot", allowed: true }]);
    expect(store.listArtifacts(sessionId, owner)).toMatchObject([{ direction: "DOWNLOAD" }]);
    await broker.close(sessionId, owner);

    const interrupted = broker.create(owner);
    expect(interrupted).toMatch(/^browser_/);
    store.close();
    store = new DurableBrowserSessionStore(databasePath);
    expect(store.reconcileInterrupted()).toBe(1);
    expect(store.reconcileInterrupted()).toBe(0);
    store.close();
  });

  it("streams quarantined bytes into encrypted storage and materializes an authorized upload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-browser-artifact-")); cleanup.push(directory);
    const source = join(directory, "source.bin");
    const restored = join(directory, "restored.bin");
    const data = Buffer.alloc(1024 * 1024 + 17, 0x5a);
    writeFileSync(source, data);
    const principal = { appId: "app", tenantId: "tenant", userId: "user", scopes: ["artifacts:read"] };
    const artifacts = new LocalArtifactStore(join(directory, "store"), Buffer.alloc(32, 9));
    const record = await artifacts.publishFromFile({
      runId: "run", workspaceId: "workspace", principal,
      path: "browser/download.bin", mediaType: "application/octet-stream", sourcePath: source,
    });
    expect(artifacts.describe(record.id, principal)).toEqual(record);
    expect(artifacts.get(record.id, principal)?.data).toEqual(data);
    await artifacts.materializeToFile(record.id, principal, restored);
    expect(readFileSync(restored)).toEqual(data);
  });

  it("maps only validated quarantine files out of the browser container", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-browser-quarantine-test-")); cleanup.push(directory);
    let mountedRoot = "";
    const process = new QuarantineFakeDriver(() => mountedRoot);
    const processFactory: BrowserProcessFactory = (spec) => {
      const mount = spec.args?.find((argument) => argument.startsWith("type=bind,source="));
      mountedRoot = mount?.slice("type=bind,source=".length).replace(",target=/quarantine", "") ?? "";
      return process;
    };
    const driver = new DockerBrowserDriver({
      image: `sha256:${"c".repeat(64)}`,
      quarantineRoot: directory,
      dockerRunner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      processFactory,
    });
    await driver.start({});
    const uploadId = await driver.prepareUpload("input.txt", async (path) => writeFileSync(path, "authorized"));
    expect(readFileSync(join(mountedRoot, uploadId), "utf8")).toBe("authorized");
    const result = await driver.execute({ action: "screenshot" });
    expect(result.artifact?.localPath).toBe(join(mountedRoot, result.artifact?.quarantineId as string));
    driver.releaseArtifact(result.artifact?.localPath as string);
    expect(() => readFileSync(result.artifact?.localPath as string)).toThrow();
    await driver.stop();
  });

  it("bounds retained upload staging and removes it at session teardown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-browser-upload-quota-")); cleanup.push(directory);
    let mountedRoot = "";
    const driver = new DockerBrowserDriver({
      image: `sha256:${"e".repeat(64)}`,
      quarantineRoot: directory,
      dockerRunner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      processFactory: (spec) => {
        const mount = spec.args?.find((argument) => argument.startsWith("type=bind,source="));
        mountedRoot = mount?.slice("type=bind,source=".length).replace(",target=/quarantine", "") ?? "";
        return new QuarantineFakeDriver(() => mountedRoot);
      },
      maxRetainedUploads: 2,
      maxRetainedUploadBytes: 5,
    });
    await driver.start({});
    await driver.prepareUpload("first.txt", async (path) => writeFileSync(path, "1234"));
    await expect(driver.prepareUpload("too-large.txt", async (path) => writeFileSync(path, "12")))
      .rejects.toThrow(/byte quota/);
    await driver.prepareUpload("second.txt", async (path) => writeFileSync(path, "5"));
    await expect(driver.prepareUpload("too-many.txt", async (path) => writeFileSync(path, "6")))
      .rejects.toThrow(/count quota/);
    expect(readdirSync(mountedRoot)).toHaveLength(2);
    await driver.stop();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("reserves retained upload slots across concurrent materializers and releases failed reservations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-browser-upload-reservation-")); cleanup.push(directory);
    let mountedRoot = "";
    const driver = new DockerBrowserDriver({
      image: `sha256:${"f".repeat(64)}`,
      quarantineRoot: directory,
      dockerRunner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      processFactory: (spec) => {
        const mount = spec.args?.find((argument) => argument.startsWith("type=bind,source="));
        mountedRoot = mount?.slice("type=bind,source=".length).replace(",target=/quarantine", "") ?? "";
        return new QuarantineFakeDriver(() => mountedRoot);
      },
      maxRetainedUploads: 1,
      maxRetainedUploadBytes: 1024,
    });
    await driver.start({});

    let releaseSuccess!: () => void;
    let markSuccessStarted!: () => void;
    const successGate = new Promise<void>((resolve) => { releaseSuccess = resolve; });
    const successStarted = new Promise<void>((resolve) => { markSuccessStarted = resolve; });
    const pendingSuccess = driver.prepareUpload("pending-success.txt", async (path) => {
      markSuccessStarted();
      await successGate;
      writeFileSync(path, "success");
    });
    await successStarted;
    let blockedMaterializerRan = false;
    await expect(driver.prepareUpload("blocked.txt", async (path) => {
      blockedMaterializerRan = true;
      writeFileSync(path, "blocked");
    })).rejects.toThrow(/count quota/);
    expect(blockedMaterializerRan).toBe(false);
    releaseSuccess();
    const retainedId = await pendingSuccess;
    driver.releaseArtifact(join(mountedRoot, retainedId));

    let releaseFailure!: () => void;
    let markFailureStarted!: () => void;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const failureStarted = new Promise<void>((resolve) => { markFailureStarted = resolve; });
    const pendingFailure = driver.prepareUpload("pending-failure.txt", async () => {
      markFailureStarted();
      await failureGate;
      throw new Error("materialization failed");
    });
    await failureStarted;
    await expect(driver.prepareUpload("blocked-again.txt", async (path) => writeFileSync(path, "blocked")))
      .rejects.toThrow(/count quota/);
    releaseFailure();
    await expect(pendingFailure).rejects.toThrow(/materialization failed/);
    const afterFailureId = await driver.prepareUpload("after-failure.txt", async (path) => writeFileSync(path, "available"));
    expect(readFileSync(join(mountedRoot, afterFailureId), "utf8")).toBe("available");
    await driver.stop();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("reaps installation-scoped browser containers and networks after restart", async () => {
    const calls: string[][] = [];
    const result = await reconcileBrowserResources({
      installationId: "installation-one",
      runner: async (args) => {
        calls.push([...args]);
        if (args[0] === "ps") return { code: 0, stdout: "container-one\ncontainer-two\n", stderr: "" };
        if (args[0] === "network" && args[1] === "ls") return { code: 0, stdout: "network-one\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result).toEqual({ containers: 2, networks: 1 });
    expect(calls).toEqual(expect.arrayContaining([
      ["container", "rm", "--force", "container-one"],
      ["container", "rm", "--force", "container-two"],
      ["network", "rm", "network-one"],
    ]));
    expect(calls[0]).toEqual(expect.arrayContaining(["--filter", "label=lite-harness.kind=browser"]));
  });
});

class FakeDriver implements BrowserDriver {
  async start(_policy: BrowserNetworkPolicy): Promise<void> {}
  async execute(_command: BrowserAction): Promise<BrowserActionResult> { return { title: "fixture" }; }
  async stop(): Promise<void> {}
}

class QuarantineFakeDriver implements BrowserDriver {
  constructor(private readonly root: () => string) {}
  async start(_policy: BrowserNetworkPolicy): Promise<void> {}
  async execute(_command: BrowserAction): Promise<BrowserActionResult> {
    const quarantineId = `q_${"d".repeat(32)}`;
    writeFileSync(join(this.root(), quarantineId), "png");
    return { artifact: { name: "screenshot.png", mediaType: "image/png", quarantineId, sizeBytes: 3 } };
  }
  async stop(): Promise<void> {}
}
