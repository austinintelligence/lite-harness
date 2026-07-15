import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerBrowserDriver,
  EncryptedBrowserProfileStore,
  ManagedBrowserBroker,
  assertBrowserUrlAllowed,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserDriver,
  type BrowserNetworkPolicy,
} from "@lite-harness/browser";
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

function requireHmac(body: Buffer, timestamp: string, secret: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
}

function requiredBrowserImage(): string {
  const value = process.env.LITE_HARNESS_TEST_BROWSER_IMAGE?.trim();
  if (!value) throw new Error("LITE_HARNESS_TEST_BROWSER_IMAGE is required; run this suite through pnpm test:real-runtime");
  return value;
}
