import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InternalPrincipal } from "@lite-harness/contracts";
import {
  DockerBrowserDriver,
  EncryptedBrowserProfileStore,
  ManagedBrowserBroker,
  assertBrowserUrlAllowed,
  reconcileBrowserResources,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserDriver,
  type BrowserNetworkPolicy,
} from "@lite-harness/browser";
import { BrokeredToolRuntime, InMemoryToolRuntime } from "@lite-harness/runtime";
import { LocalArtifactStore } from "@lite-harness/workspace";
import { configureManagerBrowserCapability } from "../apps/manager/src/browser-capability.js";
import {
  DiscordConnector,
  DeliveryCoordinator,
  InboundRunRouter,
  SlackConnector,
  SqliteIntegrationStore,
  TelegramConnector,
  WebhookCallbackConnector,
  composeInboundPrompt,
  normalizeInbound,
  verifyDiscordRequest,
  verifySlackRequest,
  verifyTelegramSecret,
} from "@lite-harness/integrations";
import { SchedulerEngine, SqliteTriggerStore } from "@lite-harness/automation";

const cleanup: string[] = [];
const browserImage = requiredBrowserImage();
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("managed browser broker", () => {
  it("denies reserved and IPv4-mapped private destinations", async () => {
    await expect(assertBrowserUrlAllowed("https://reserved.example", {}, async () => ["203.0.113.4"]))
      .rejects.toThrow(/private or metadata/);
    await expect(assertBrowserUrlAllowed("https://mapped.example", {}, async () => ["::ffff:127.0.0.1"]))
      .rejects.toThrow(/private or metadata/);
  });

  it("isolates owners, audits actions, and removes an idle driver", async () => {
    const drivers: FakeBrowserDriver[] = [];
    const audit: Array<{ allowed: boolean; action: string }> = [];
    const broker = new ManagedBrowserBroker(() => {
      const driver = new FakeBrowserDriver(); drivers.push(driver); return driver;
    }, { idleTtlMs: 10, audit: (record) => audit.push(record) });
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run" };
    const session = broker.create(owner, { allowedOrigins: ["https://example.com"] });
    await expect(broker.execute(session, { ...owner, runId: "other" }, { action: "snapshot" }))
      .rejects.toThrow(/does not belong/);
    await expect(broker.execute(session, owner, { action: "snapshot" })).resolves.toMatchObject({ title: "fixture" });
    expect(audit).toMatchObject([{ allowed: true, action: "snapshot" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(broker.activeCount).toBe(0);
    expect(drivers[0]?.stops).toBe(1);
  });

  it("requires an immutable managed-browser image", () => {
    expect(() => new DockerBrowserDriver({ image: "playwright:latest" })).toThrow(/pinned by sha256/);
  });

  it("encrypts same-named profiles in distinct owner-scoped storage paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-browser-profile-")); cleanup.push(directory);
    const profiles = new EncryptedBrowserProfileStore(directory, Buffer.alloc(32, 7));
    const owner = { appId: "app", tenantId: "tenant", userId: "user" };
    const other = { ...owner, tenantId: "other" };
    await profiles.save("default", owner, JSON.stringify({ cookies: [{ name: "session", value: "primary" }] }));
    await profiles.save("default", other, JSON.stringify({ cookies: [{ name: "session", value: "other" }] }));
    await expect(profiles.load("default", owner)).resolves.toContain("primary");
    await expect(profiles.load("default", other)).resolves.toContain("other");
  });

  it("runs the pinned Chromium sidecar and stops it", async () => {
    const driver = new DockerBrowserDriver({ image: browserImage, timeoutMs: 60_000 });
    try {
      await driver.start({ allowedOrigins: ["https://example.com"] });
      await expect(driver.execute({ action: "navigate", url: "https://example.com" })).resolves.toMatchObject({
        url: "https://example.com/", title: "Example Domain",
      });
      await expect(driver.execute({ action: "snapshot" })).resolves.toMatchObject({
        snapshot: { text: expect.stringContaining("Example Domain") },
      });
      const screenshot = await driver.execute({ action: "screenshot" });
      expect(screenshot.artifact).toMatchObject({ name: "screenshot.png", mediaType: "image/png" });
      expect(readFileSync(screenshot.artifact?.localPath as string).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      driver.releaseArtifact(screenshot.artifact?.localPath as string);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  it("serializes an overlapping navigation and snapshot against one observed page", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<!doctype html><button aria-label="Serialized control">Serialized control</button>');
      }, 100);
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const origin = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;
    const driver = new DockerBrowserDriver({ image: browserImage, timeoutMs: 60_000 });
    try {
      await driver.start({ allowedOrigins: [origin], allowPrivateNetworks: true });
      const navigation = driver.execute({ action: "navigate", url: origin });
      const concurrentSnapshot = driver.execute({ action: "snapshot" });
      await expect(navigation).resolves.toMatchObject({ url: `${origin}/` });
      await expect(concurrentSnapshot).resolves.toMatchObject({
        url: `${origin}/`,
        snapshot: { elements: [{ ref: "e1", name: "Serialized control" }] },
      });
    } finally {
      await driver.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 90_000);

  it("A22-REAL-BROWSER-IDLE-ZERO reaps real Chromium, egress, network, and quarantine state after idle", async () => {
    const installationId = mkdtempSync(join(tmpdir(), "lite-browser-idle-")); cleanup.push(installationId);
    const quarantineRoot = join(installationId, "quarantine");
    const broker = new ManagedBrowserBroker(() => new DockerBrowserDriver({
      image: browserImage, installationId, quarantineRoot, timeoutMs: 60_000,
    }), { idleTtlMs: 100 });
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run-real-idle" };
    try {
      const session = broker.create(owner);
      await expect(broker.execute(session, owner, { action: "snapshot" })).resolves.toMatchObject({ snapshot: expect.any(Object) });
      const label = createHash("sha256").update(installationId).digest("hex").slice(0, 32);
      await waitFor(() => broker.activeCount === 0 && browserDockerResources(label).length === 0, 15_000);
      expect(broker.activeCount).toBe(0);
      expect(browserDockerResources(label)).toEqual([]);
    } finally {
      await broker.closeAll();
      await reconcileBrowserResources({ installationId }).catch(() => undefined);
    }
  }, 90_000);

  it("uploads an authorized file and quarantines a streamed download", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/download") {
        response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=fixture.txt" });
        response.end("downloaded-through-quarantine");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><input type="file" aria-label="Upload fixture"><a href="/download" aria-label="Download fixture">Download</a>');
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const origin = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;
    const driver = new DockerBrowserDriver({ image: browserImage, timeoutMs: 60_000 });
    try {
      await driver.start({ allowedOrigins: [origin], allowPrivateNetworks: true });
      await driver.execute({ action: "navigate", url: origin });
      const snapshot = await driver.execute({ action: "snapshot" });
      expect(snapshot.snapshot?.elements).toMatchObject([
        { ref: "e1", name: "Upload fixture" },
        { ref: "e2", name: "Download fixture" },
      ]);
      const quarantineId = await driver.prepareUpload("fixture.txt", async (path) => writeFileSync(path, "authorized-upload"));
      await expect(driver.execute({ action: "upload", ref: "e1", quarantineId, name: "fixture.txt" })).resolves.toBeDefined();
      const download = await driver.execute({ action: "click", ref: "e2", expectDownload: true });
      expect(readFileSync(download.artifact?.localPath as string, "utf8")).toBe("downloaded-through-quarantine");
      driver.releaseArtifact(download.artifact?.localPath as string);
    } finally {
      await driver.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 90_000);

  it("A20-RECORDED-REAL-TASK completes the owner-safe Manager browser workflow and tears down at idle", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lite-browser-a20-")); cleanup.push(dataDir);
    const ssrfDataDir = mkdtempSync(join(tmpdir(), "lite-browser-a20-ssrf-")); cleanup.push(ssrfDataDir);
    const artifacts = new LocalArtifactStore(join(dataDir, "artifacts"), Buffer.alloc(32, 0x41));
    const runtime = new BrokeredToolRuntime(new InMemoryToolRuntime());
    const profileKey = Buffer.alloc(32, 0x52);
    const ownerA: InternalPrincipal = {
      appId: "browser-app", tenantId: "tenant-a", userId: "shared-user", scopes: ["artifacts:read"],
    };
    const ownerB: InternalPrincipal = {
      appId: "browser-app", tenantId: "tenant-b", userId: "shared-user", scopes: ["artifacts:read"],
    };
    const workspaceA = "workspace-a";
    const workspaceB = "workspace-b";
    const server = createServer((request, response) => {
      if (request.url === "/download") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename=manager-download.txt",
        });
        response.end("download-promoted-by-manager");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(a20TaskPage());
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const origin = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;
    const installationLabel = createHash("sha256").update(dataDir).digest("hex").slice(0, 32);
    const capability = await configureManagerBrowserCapability({
      runtime,
      artifacts,
      dataDir,
      image: browserImage,
      allowedOrigins: [origin],
      allowPrivateNetworks: true,
      idleTtlMs: 1_000,
      profileId: "shared-profile",
      profileKey,
      driverTimeoutMs: 60_000,
    });
    let ssrfCapability: Awaited<ReturnType<typeof configureManagerBrowserCapability>> | undefined;
    try {
      const upload = artifacts.publish({
        runId: "run-a1", workspaceId: workspaceA, principal: ownerA,
        path: "fixtures/authorized-upload.txt", mediaType: "text/plain",
        data: Buffer.from("authorized-upload-through-manager"),
      });
      const sessionA = await managerBrowserOpen(runtime, "run-a1", workspaceA, ownerA);
      await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, { action: "navigate", url: origin });
      const beforeMutation = await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, { action: "snapshot" });
      const refsBefore = elementRefs(beforeMutation);
      expect(refsBefore).toMatchObject({
        "Mutate DOM": expect.stringMatching(/^e\d+$/),
        "Display name": expect.stringMatching(/^e\d+$/),
        "Plan": expect.stringMatching(/^e\d+$/),
        "Upload fixture": expect.stringMatching(/^e\d+$/),
        "Save profile": expect.stringMatching(/^e\d+$/),
        "Download fixture": expect.stringMatching(/^e\d+$/),
      });
      await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, {
        action: "click", ref: refsBefore["Mutate DOM"],
      });
      const afterMutation = await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, { action: "snapshot" });
      const refsAfter = elementRefs(afterMutation);
      for (const name of Object.keys(refsBefore)) expect(refsAfter[name]).toBe(refsBefore[name]);
      expect(Object.values(refsBefore)).not.toContain(refsAfter["Inserted control"]);

      await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, {
        action: "type", ref: refsAfter["Display name"], text: "owner-a",
      });
      await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, {
        action: "select", ref: refsAfter.Plan, value: "pro",
      });
      await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, {
        action: "upload", ref: refsAfter["Upload fixture"], artifactId: upload.id,
      });
      await waitForManagerBrowserText(
        runtime, "run-a1", workspaceA, ownerA, sessionA, "authorized-upload-through-manager", 5_000,
      );
      await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, {
        action: "click", ref: refsAfter["Save profile"],
      });

      const screenshot = await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, { action: "screenshot" });
      const screenshotId = requiredArtifactId(screenshot);
      expect(artifacts.get(screenshotId, ownerA)?.data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      const download = await managerBrowserAction(runtime, "run-a1", workspaceA, ownerA, sessionA, {
        action: "click", ref: refsAfter["Download fixture"], expectDownload: true,
      });
      const downloadId = requiredArtifactId(download);
      expect(artifacts.get(downloadId, ownerA)?.data.toString("utf8")).toBe("download-promoted-by-manager");
      await managerBrowserClose(runtime, "run-a1", workspaceA, ownerA, sessionA);

      const sessionB = await managerBrowserOpen(runtime, "run-b1", workspaceB, ownerB);
      await managerBrowserAction(runtime, "run-b1", workspaceB, ownerB, sessionB, { action: "navigate", url: origin });
      const ownerBInitial = await managerBrowserAction(runtime, "run-b1", workspaceB, ownerB, sessionB, { action: "snapshot" });
      expect(ownerBInitial.snapshot?.text).toContain("Restored: none");
      const refsB = elementRefs(ownerBInitial);
      await expect(managerBrowserAction(runtime, "run-b1", workspaceB, ownerB, sessionB, {
        action: "upload", ref: refsB["Upload fixture"], artifactId: upload.id,
      })).rejects.toThrow(/unavailable in this workspace/);
      await managerBrowserAction(runtime, "run-b1", workspaceB, ownerB, sessionB, {
        action: "type", ref: refsB["Display name"], text: "owner-b",
      });
      await managerBrowserAction(runtime, "run-b1", workspaceB, ownerB, sessionB, {
        action: "select", ref: refsB.Plan, value: "basic",
      });
      await managerBrowserAction(runtime, "run-b1", workspaceB, ownerB, sessionB, {
        action: "click", ref: refsB["Save profile"],
      });
      await managerBrowserClose(runtime, "run-b1", workspaceB, ownerB, sessionB);

      const encryptedProfiles = profileFiles(join(dataDir, "browser-profiles"));
      expect(encryptedProfiles).toHaveLength(2);
      const encodedProfiles = encryptedProfiles.map((path) => readFileSync(path, "utf8")).join("\n");
      expect(encodedProfiles).not.toContain("owner-a");
      expect(encodedProfiles).not.toContain("owner-b");

      const restoredA = await managerBrowserOpen(runtime, "run-a2", workspaceA, ownerA);
      await managerBrowserAction(runtime, "run-a2", workspaceA, ownerA, restoredA, { action: "navigate", url: origin });
      expect((await managerBrowserAction(runtime, "run-a2", workspaceA, ownerA, restoredA, { action: "snapshot" })).snapshot?.text)
        .toContain("Restored: owner-a/pro");

      const ssrfRuntime = new BrokeredToolRuntime(new InMemoryToolRuntime());
      ssrfCapability = await configureManagerBrowserCapability({
        runtime: ssrfRuntime,
        artifacts: new LocalArtifactStore(join(ssrfDataDir, "artifacts"), Buffer.alloc(32, 0x63)),
        dataDir: ssrfDataDir,
        image: browserImage,
        allowedOrigins: ["http://127.0.0.1:1"],
        allowPrivateNetworks: false,
        idleTtlMs: 5_000,
        driverTimeoutMs: 60_000,
      });
      const ssrfSession = await managerBrowserOpen(ssrfRuntime, "run-ssrf", "workspace-ssrf", ownerA);
      await expect(managerBrowserAction(ssrfRuntime, "run-ssrf", "workspace-ssrf", ownerA, ssrfSession, {
        action: "navigate", url: "http://127.0.0.1:1/private",
      })).rejects.toThrow(/private or metadata/);
      expect(browserDockerResources(createHash("sha256").update(ssrfDataDir).digest("hex").slice(0, 32))).toEqual([]);
      await managerBrowserClose(ssrfRuntime, "run-ssrf", "workspace-ssrf", ownerA, ssrfSession);

      await waitFor(() => capability.activeCount === 0 && browserDockerResources(installationLabel).length === 0, 30_000);
      expect(capability.activeCount).toBe(0);
      expect(browserDockerResources(installationLabel)).toEqual([]);
      expect(readdirSync(join(dataDir, "browser-quarantine"))).toEqual([]);
    } finally {
      await ssrfCapability?.stop().catch(() => undefined);
      await capability.stop().catch(() => undefined);
      await reconcileBrowserResources({ installationId: ssrfDataDir }).catch(() => undefined);
      await reconcileBrowserResources({ installationId: dataDir }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 180_000);
});

describe("durable automation", () => {
  it("survives restart and does not fire one occurrence twice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-automation-")); cleanup.push(directory);
    const path = join(directory, "automation.db");
    const runs = vi.fn(async () => undefined);
    let store = new SqliteTriggerStore(path);
    store.put({ id: "minute", intervalMs: 60_000, nextFireAt: 1_000, payload: { input: "work" } });
    const first = new SchedulerEngine(store, "manager-a", runs);
    const overlapping = new SchedulerEngine(store, "manager-a", runs);
    expect(await Promise.all([first.tick(1_000), overlapping.tick(1_000)])).toEqual([1, 0]);
    expect(store.listFirings("minute")).toMatchObject([{ status: "COMPLETED", scheduledAt: 1_000 }]);
    store.close();

    store = new SqliteTriggerStore(path);
    expect(await new SchedulerEngine(store, "manager-b", runs).tick(1_000)).toBe(0);
    expect(await new SchedulerEngine(store, "manager-b", runs).tick(61_000)).toBe(1);
    expect(runs).toHaveBeenCalledTimes(2);
    store.close();
  });
});

describe("durable connectors", () => {
  it("deduplicates an inbound delivery after a process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-integrations-")); cleanup.push(directory);
    const path = join(directory, "integrations.db");
    const envelope = normalizeInbound({
      connectorId: "webhook", accountId: "primary", deliveryId: "delivery-1",
      senderExternalId: "sender-1", conversationExternalId: "conversation-1", text: "hello",
    });
    let store = new SqliteIntegrationStore(path);
    store.bind({
      connectorId: "webhook", accountId: "primary", senderExternalId: "sender-1",
      appId: "app", tenantId: "tenant", userId: "user", agentId: "agent",
      workspaceId: "workspace", sessionPrefix: "connector",
    });
    const starts = vi.fn(async () => "run-one");
    expect(await new InboundRunRouter(store, starts).route(envelope)).toEqual({ duplicate: false, runId: "run-one" });
    store.close();
    store = new SqliteIntegrationStore(path);
    expect(await new InboundRunRouter(store, starts).route(envelope)).toEqual({ duplicate: true, runId: "run-one" });
    expect(starts).toHaveBeenCalledOnce();
    store.close();
  });

  it("delivers one durable reply after restart and carries attachment references into the run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-delivery-")); cleanup.push(directory);
    const path = join(directory, "integrations.db");
    const envelope = normalizeInbound({
      connectorId: "webhook", accountId: "primary", deliveryId: "delivery-reply",
      senderExternalId: "sender", conversationExternalId: "conversation", text: "review these",
      attachmentUrls: ["https://files.example/report.pdf"],
    });
    expect(composeInboundPrompt(envelope)).toContain("https://files.example/report.pdf");
    let store = new SqliteIntegrationStore(path);
    store.bind({ connectorId: "webhook", accountId: "primary", senderExternalId: "sender",
      appId: "app", tenantId: "tenant", userId: "user", agentId: "agent", workspaceId: "workspace", sessionPrefix: "hook" });
    await new InboundRunRouter(store, async () => "run-complete").route(envelope);
    store.close();

    store = new SqliteIntegrationStore(path);
    const sends = vi.fn(async () => ({ externalId: "reply-one" }));
    const coordinator = new DeliveryCoordinator(store, "manager-restarted", new Map([["webhook", {
      connectorId: "webhook", send: sends,
    }]]), async () => ({ terminal: true, text: "done" }));
    expect(await coordinator.tick()).toBe(1);
    expect(await coordinator.tick()).toBe(0);
    expect(sends).toHaveBeenCalledOnce();
    expect(store.getReceipt(envelope)).toMatchObject({ status: "REPLIED", replyExternalId: "reply-one" });
    store.close();
  });

  it("verifies Telegram, Slack, and Discord webhook authenticity", () => {
    expect(verifyTelegramSecret("secret", "secret")).toBe(true);
    const body = Buffer.from("{\"event\":1}");
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const crypto = requireHmac(body, timestamp, "slack-secret");
    expect(verifySlackRequest(body, timestamp, crypto, Buffer.from("slack-secret"))).toBe(true);
    const keys = generateKeyPairSync("ed25519");
    const discordTimestamp = "1700000000";
    const signature = sign(null, Buffer.concat([Buffer.from(discordTimestamp), body]), keys.privateKey).toString("hex");
    const rawPublicKey = Buffer.from(keys.publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
    expect(verifyDiscordRequest(body, discordTimestamp, signature, rawPublicKey)).toBe(true);
  });

  it("sends normalized outbound messages through fixed provider origins", async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("telegram")) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      if (url.includes("discord")) return new Response(JSON.stringify({ id: "discord-1" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, ts: "slack-1" }), { status: 200 });
    });
    const secret = async () => "connector-token";
    const message = { accountId: "primary", conversationExternalId: "channel", text: "hello" };
    const transport = fetch as unknown as typeof globalThis.fetch;
    await expect(new TelegramConnector(secret, transport).send(message)).resolves.toEqual({ externalId: "1" });
    await expect(new DiscordConnector(secret, transport).send(message)).resolves.toEqual({ externalId: "discord-1" });
    await expect(new SlackConnector(secret, transport).send(message)).resolves.toEqual({ externalId: "slack-1" });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
      "https://api.telegram.org", "https://discord.com", "https://slack.com",
    ]);
  });

  it("signs fixed-origin webhook callbacks with a stable idempotency key", async () => {
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = String(init?.body);
      expect(init?.headers).toMatchObject({
        "idempotency-key": "reply:one",
        "x-lite-signature": `sha256=${createHmac("sha256", "reply-secret").update(body).digest("hex")}`,
      });
      return new Response(null, { status: 202, headers: { "x-lite-delivery-id": "accepted-one" } });
    });
    const connector = new WebhookCallbackConnector(async () => ({ url: "https://app.example/callback", secret: "reply-secret" }),
      fetch as unknown as typeof globalThis.fetch);
    await expect(connector.send({ accountId: "primary", conversationExternalId: "thread", text: "done", idempotencyKey: "reply:one" }))
      .resolves.toEqual({ externalId: "accepted-one" });
  });
});

class FakeBrowserDriver implements BrowserDriver {
  starts = 0;
  stops = 0;
  async start(_policy: BrowserNetworkPolicy): Promise<void> { this.starts += 1; }
  async execute(_command: BrowserAction): Promise<BrowserActionResult> { return { title: "fixture" }; }
  async stop(): Promise<void> { this.stops += 1; }
}

interface ManagerBrowserTaskResult {
  snapshot?: { text: string; elements: Array<{ ref: string; role: string; name: string }> };
  artifact?: { id?: string };
}

let managerBrowserCall = 0;

async function managerBrowserOpen(
  runtime: BrokeredToolRuntime,
  runId: string,
  workspaceId: string,
  principal: InternalPrincipal,
): Promise<string> {
  const result = await managerBrowserTool(runtime, "browser_open", runId, workspaceId, principal, {});
  if (typeof result.sessionId !== "string") throw new Error("Manager browser_open did not return a session id");
  return result.sessionId;
}

async function managerBrowserAction(
  runtime: BrokeredToolRuntime,
  runId: string,
  workspaceId: string,
  principal: InternalPrincipal,
  sessionId: string,
  command: Record<string, unknown>,
): Promise<ManagerBrowserTaskResult> {
  return (await managerBrowserTool(
    runtime, "browser_action", runId, workspaceId, principal, { sessionId, command },
  )) as unknown as ManagerBrowserTaskResult;
}

async function waitForManagerBrowserText(
  runtime: BrokeredToolRuntime,
  runId: string,
  workspaceId: string,
  principal: InternalPrincipal,
  sessionId: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await managerBrowserAction(runtime, runId, workspaceId, principal, sessionId, { action: "snapshot" });
    if (result.snapshot?.text.includes(expected)) return;
    await managerBrowserAction(runtime, runId, workspaceId, principal, sessionId, { action: "wait", milliseconds: 50 });
  }
  throw new Error(`Timed out waiting for browser text: ${expected}`);
}

async function managerBrowserClose(
  runtime: BrokeredToolRuntime,
  runId: string,
  workspaceId: string,
  principal: InternalPrincipal,
  sessionId: string,
): Promise<void> {
  await managerBrowserTool(runtime, "browser_close", runId, workspaceId, principal, { sessionId });
}

async function managerBrowserTool(
  runtime: BrokeredToolRuntime,
  name: string,
  runId: string,
  workspaceId: string,
  principal: InternalPrincipal,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  managerBrowserCall += 1;
  const result = await runtime.execute({
    runId,
    workspaceId,
    principal,
    allowedTools: [name],
    call: { id: `a20-call-${managerBrowserCall}`, name, arguments: arguments_ },
  });
  if (!result.ok) throw new Error(result.content);
  const parsed = JSON.parse(result.content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Manager browser tool returned invalid JSON");
  return parsed as Record<string, unknown>;
}

function elementRefs(result: ManagerBrowserTaskResult): Record<string, string> {
  if (!result.snapshot) throw new Error("Browser task did not return a snapshot");
  return Object.fromEntries(result.snapshot.elements.map((element) => [element.name, element.ref]));
}

function requiredArtifactId(result: ManagerBrowserTaskResult): string {
  const id = result.artifact?.id;
  if (typeof id !== "string") throw new Error("Manager browser action did not promote an artifact");
  return id;
}

function profileFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? profileFiles(path) : entry.isFile() ? [path] : [];
  });
}

function a20TaskPage(): string {
  return `<!doctype html>
    <html><head><title>A20 Manager browser task</title></head><body>
      <main>
        <button id="mutate" type="button" aria-label="Mutate DOM">Mutate DOM</button>
        <label>Name <input id="display-name" aria-label="Display name"></label>
        <label>Plan <select id="plan" aria-label="Plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label>
        <label>File <input id="upload" type="file" aria-label="Upload fixture"></label>
        <button id="save" type="button" aria-label="Save profile">Save profile</button>
        <a href="/download" aria-label="Download fixture">Download fixture</a>
        <output id="restored"></output><output id="upload-status"></output>
      </main>
      <script>
        const restored = document.getElementById('restored');
        restored.textContent = 'Restored: ' + (localStorage.getItem('profile') || 'none');
        document.getElementById('mutate').addEventListener('click', () => {
          if (document.querySelector('[aria-label="Inserted control"]')) return;
          const inserted = document.createElement('button');
          inserted.type = 'button';
          inserted.setAttribute('aria-label', 'Inserted control');
          inserted.setAttribute('data-lite-ref', 'e2');
          inserted.textContent = 'Inserted control';
          document.querySelector('main').prepend(inserted);
        });
        document.getElementById('upload').addEventListener('change', async (event) => {
          const file = event.target.files[0];
          document.getElementById('upload-status').textContent = file ? 'Upload: ' + file.name + ':' + await file.text() : 'Upload: none';
        });
        document.getElementById('save').addEventListener('click', () => {
          const value = document.getElementById('display-name').value + '/' + document.getElementById('plan').value;
          localStorage.setItem('profile', value);
          restored.textContent = 'Restored: ' + value;
        });
      </script>
    </body></html>`;
}

function requireHmac(body: Buffer, timestamp: string, secret: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
}

function requiredBrowserImage(): string {
  const value = process.env.LITE_HARNESS_TEST_BROWSER_IMAGE?.trim();
  if (!value) throw new Error("LITE_HARNESS_TEST_BROWSER_IMAGE is required; run this suite through pnpm test:real-runtime");
  return value;
}

function browserDockerResources(installationLabel: string): string[] {
  const filter = ["--filter", `label=lite-harness.installation=${installationLabel}`, "--format", "{{.ID}}"];
  const containers = spawnSync("docker", ["ps", "--all", ...filter], { encoding: "utf8", windowsHide: true });
  const networks = spawnSync("docker", ["network", "ls", ...filter], { encoding: "utf8", windowsHide: true });
  if (containers.status !== 0 || networks.status !== 0) throw new Error("Could not inspect browser scale-to-zero resources");
  return `${containers.stdout}\n${networks.stdout}`.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for browser scale-to-zero cleanup");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
