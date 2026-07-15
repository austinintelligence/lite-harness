import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("durable browser sessions and artifact quarantine", () => {
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
