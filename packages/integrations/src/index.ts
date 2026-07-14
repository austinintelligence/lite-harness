import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface InboundEnvelope {
  connectorId: string;
  accountId: string;
  deliveryId: string;
  senderExternalId: string;
  threadExternalId?: string;
  conversationExternalId?: string;
  text: string;
  attachmentUrls: readonly string[];
  receivedAt: string;
  rawDigest?: string;
}

export interface IntegrationBinding {
  connectorId: string;
  accountId: string;
  senderExternalId: string;
  appId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  sessionPrefix: string;
}

export interface DeliveryReceipt {
  connectorId: string;
  accountId: string;
  deliveryId: string;
  status: "RECEIVED" | "RUN_STARTED" | "REPLIED" | "FAILED";
  runId?: string;
  replyExternalId?: string;
  errorCode?: string;
  receivedAt: string;
  updatedAt: string;
}

export class DeliveryDedupe {
  readonly #claims = new Map<string, number>();

  claim(envelope: Pick<InboundEnvelope, "connectorId" | "accountId" | "deliveryId">, ttlMs = 86_400_000): boolean {
    this.sweep();
    const key = `${envelope.connectorId}\0${envelope.accountId}\0${envelope.deliveryId}`;
    if (this.#claims.has(key)) return false;
    this.#claims.set(key, Date.now() + ttlMs);
    return true;
  }

  sweep(now = Date.now()): void {
    for (const [key, expiresAt] of this.#claims) if (expiresAt <= now) this.#claims.delete(key);
  }
}

export class SqliteIntegrationStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS integration_bindings (
        connector_id TEXT NOT NULL, account_id TEXT NOT NULL, sender_external_id TEXT NOT NULL,
        app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_prefix TEXT NOT NULL,
        PRIMARY KEY(connector_id, account_id, sender_external_id)
      );
      CREATE TABLE IF NOT EXISTS integration_deliveries (
        connector_id TEXT NOT NULL, account_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, reply_external_id TEXT,
        error_code TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, account_id, delivery_id)
      );
    `);
  }

  bind(binding: IntegrationBinding): void {
    this.#database.prepare(`
      INSERT INTO integration_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, account_id, sender_external_id) DO UPDATE SET
        app_id=excluded.app_id, tenant_id=excluded.tenant_id, user_id=excluded.user_id,
        agent_id=excluded.agent_id, workspace_id=excluded.workspace_id, session_prefix=excluded.session_prefix
    `).run(
      binding.connectorId, binding.accountId, binding.senderExternalId, binding.appId, binding.tenantId,
      binding.userId, binding.agentId, binding.workspaceId, binding.sessionPrefix,
    );
  }

  getBinding(envelope: Pick<InboundEnvelope, "connectorId" | "accountId" | "senderExternalId">): IntegrationBinding | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM integration_bindings WHERE connector_id = ? AND account_id = ?
        AND sender_external_id IN (?, '*') ORDER BY sender_external_id = ? DESC LIMIT 1
    `).get(envelope.connectorId, envelope.accountId, envelope.senderExternalId, envelope.senderExternalId) as Record<string, unknown> | undefined;
    return row ? {
      connectorId: row.connector_id as string, accountId: row.account_id as string,
      senderExternalId: row.sender_external_id as string, appId: row.app_id as string,
      tenantId: row.tenant_id as string, userId: row.user_id as string, agentId: row.agent_id as string,
      workspaceId: row.workspace_id as string, sessionPrefix: row.session_prefix as string,
    } : undefined;
  }

  claim(envelope: InboundEnvelope): boolean {
    const now = new Date().toISOString();
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO integration_deliveries(
        connector_id, account_id, delivery_id, envelope_json, status, received_at, updated_at
      ) VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?)
    `).run(envelope.connectorId, envelope.accountId, envelope.deliveryId, JSON.stringify(envelope), envelope.receivedAt, now);
    return result.changes === 1;
  }

  markRun(envelope: Pick<InboundEnvelope, "connectorId" | "accountId" | "deliveryId">, runId: string): DeliveryReceipt {
    return this.#update(envelope, "RUN_STARTED", { runId });
  }

  markReply(envelope: Pick<InboundEnvelope, "connectorId" | "accountId" | "deliveryId">, replyExternalId: string): DeliveryReceipt {
    return this.#update(envelope, "REPLIED", { replyExternalId });
  }

  markFailed(envelope: Pick<InboundEnvelope, "connectorId" | "accountId" | "deliveryId">, errorCode: string): DeliveryReceipt {
    return this.#update(envelope, "FAILED", { errorCode });
  }

  getReceipt(envelope: Pick<InboundEnvelope, "connectorId" | "accountId" | "deliveryId">): DeliveryReceipt | undefined {
    const row = this.#database.prepare(`SELECT * FROM integration_deliveries
      WHERE connector_id = ? AND account_id = ? AND delivery_id = ?`).get(
      envelope.connectorId, envelope.accountId, envelope.deliveryId,
    ) as Record<string, unknown> | undefined;
    return row ? toReceipt(row) : undefined;
  }

  close(): void { this.#database.close(); }

  #update(
    envelope: Pick<InboundEnvelope, "connectorId" | "accountId" | "deliveryId">,
    status: DeliveryReceipt["status"],
    fields: { runId?: string; replyExternalId?: string; errorCode?: string },
  ): DeliveryReceipt {
    this.#database.prepare(`UPDATE integration_deliveries SET status = ?,
      run_id = COALESCE(?, run_id), reply_external_id = COALESCE(?, reply_external_id),
      error_code = COALESCE(?, error_code), updated_at = ?
      WHERE connector_id = ? AND account_id = ? AND delivery_id = ?`).run(
      status, fields.runId ?? null, fields.replyExternalId ?? null, fields.errorCode ?? null,
      new Date().toISOString(), envelope.connectorId, envelope.accountId, envelope.deliveryId,
    );
    const receipt = this.getReceipt(envelope);
    if (!receipt) throw new Error("Integration delivery was not claimed");
    return receipt;
  }
}

export class InboundRunRouter {
  constructor(
    private readonly store: SqliteIntegrationStore,
    private readonly startRun: (request: {
      binding: IntegrationBinding;
      envelope: InboundEnvelope;
      sessionId: string;
    }) => Promise<string>,
  ) {}

  async route(envelope: InboundEnvelope): Promise<{ duplicate: boolean; runId?: string }> {
    if (!this.store.claim(envelope)) {
      const runId = this.store.getReceipt(envelope)?.runId;
      return { duplicate: true, ...(runId ? { runId } : {}) };
    }
    const binding = this.store.getBinding(envelope);
    if (!binding) {
      this.store.markFailed(envelope, "binding_missing");
      throw new Error("No integration binding matches the sender");
    }
    try {
      const conversation = envelope.threadExternalId ?? envelope.conversationExternalId ?? envelope.senderExternalId;
      const sessionId = `${binding.sessionPrefix}_${createHash("sha256").update(conversation).digest("hex").slice(0, 24)}`;
      const runId = await this.startRun({ binding, envelope, sessionId });
      this.store.markRun(envelope, runId);
      return { duplicate: false, runId };
    } catch (error) {
      this.store.markFailed(envelope, "run_start_failed");
      throw error;
    }
  }
}

export function verifyHmacSha256(body: Buffer, signature: string, secret: Buffer): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signature.replace(/^sha256=/, "").toLowerCase();
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function verifySlackRequest(body: Buffer, timestamp: string, signature: string, secret: Buffer, now = Date.now()): boolean {
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds * 1_000) > 5 * 60_000) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
  return safeEqual(expected, signature);
}

export function verifyTelegramSecret(actual: string | undefined, expected: string): boolean {
  return Boolean(actual) && safeEqual(actual as string, expected);
}

export function verifyDiscordRequest(body: Buffer, timestamp: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]),
      format: "der", type: "spki",
    });
    return verify(null, Buffer.concat([Buffer.from(timestamp), body]), key, Buffer.from(signatureHex, "hex"));
  } catch { return false; }
}

export interface OutboundMessage {
  accountId: string;
  conversationExternalId: string;
  threadExternalId?: string;
  text: string;
}

export interface ConnectorAdapter {
  readonly connectorId: string;
  send(message: OutboundMessage, signal?: AbortSignal): Promise<{ externalId: string }>;
}

type SecretResolver = (accountId: string) => Promise<string>;

export class TelegramConnector implements ConnectorAdapter {
  readonly connectorId = "telegram";
  constructor(private readonly secret: SecretResolver, private readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}
  async send(message: OutboundMessage, signal?: AbortSignal): Promise<{ externalId: string }> {
    validateOutbound(message, 4_096);
    const token = await this.secret(message.accountId);
    if (!/^[A-Za-z0-9:_-]+$/.test(token)) throw new ConnectorError("credential_invalid", "Telegram credential is malformed", false);
    const response = await safeFetch(this.fetch, `https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ chat_id: message.conversationExternalId, text: message.text,
        ...(message.threadExternalId ? { message_thread_id: message.threadExternalId } : {}) }),
    }, "Telegram");
    const body = await jsonResponse(response, "Telegram");
    return { externalId: String(recordAt(body, "result", "message_id") ?? "unknown") };
  }
}

export class DiscordConnector implements ConnectorAdapter {
  readonly connectorId = "discord";
  constructor(private readonly secret: SecretResolver, private readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}
  async send(message: OutboundMessage, signal?: AbortSignal): Promise<{ externalId: string }> {
    validateOutbound(message, 2_000);
    const token = await this.secret(message.accountId);
    if (!token) throw new ConnectorError("credential_invalid", "Discord credential is empty", false);
    const response = await safeFetch(this.fetch, `https://discord.com/api/v10/channels/${encodeURIComponent(message.conversationExternalId)}/messages`, {
      method: "POST", headers: { authorization: `Bot ${token}`, "content-type": "application/json" }, signal,
      body: JSON.stringify({ content: message.text }),
    }, "Discord");
    const body = await jsonResponse(response, "Discord");
    return { externalId: String(recordAt(body, "id") ?? "unknown") };
  }
}

export class SlackConnector implements ConnectorAdapter {
  readonly connectorId = "slack";
  constructor(private readonly secret: SecretResolver, private readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}
  async send(message: OutboundMessage, signal?: AbortSignal): Promise<{ externalId: string }> {
    validateOutbound(message, 40_000);
    const token = await this.secret(message.accountId);
    if (!token) throw new ConnectorError("credential_invalid", "Slack credential is empty", false);
    const response = await safeFetch(this.fetch, "https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, signal,
      body: JSON.stringify({ channel: message.conversationExternalId, text: message.text,
        ...(message.threadExternalId ? { thread_ts: message.threadExternalId } : {}) }),
    }, "Slack");
    const body = await jsonResponse(response, "Slack");
    if (recordAt(body, "ok") !== true) throw new ConnectorError("connector_rejected", `Slack rejected the message: ${String(recordAt(body, "error") ?? "unknown")}`, false);
    return { externalId: String(recordAt(body, "ts") ?? "unknown") };
  }
}

export class ConnectorError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(message); this.name = "ConnectorError";
  }
}

export function normalizeInbound(value: unknown): InboundEnvelope {
  if (!value || typeof value !== "object") throw new Error("Inbound envelope must be an object");
  const record = value as Record<string, unknown>;
  for (const field of ["connectorId", "accountId", "deliveryId", "senderExternalId", "text"] as const) {
    if (typeof record[field] !== "string" || !(record[field] as string).trim()) throw new Error(`Inbound ${field} is required`);
    if ((record[field] as string).length > (field === "text" ? 200_000 : 512)) throw new Error(`Inbound ${field} is too long`);
  }
  const attachmentUrls = record.attachmentUrls ?? [];
  if (!Array.isArray(attachmentUrls) || attachmentUrls.length > 32 || !attachmentUrls.every((item) => typeof item === "string")) {
    throw new Error("Inbound attachmentUrls must be a string array");
  }
  for (const item of attachmentUrls as string[]) {
    const url = new URL(item);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Inbound attachment URLs must be credential-free HTTP(S) URLs");
    }
  }
  const receivedAt = typeof record.receivedAt === "string" ? record.receivedAt : new Date().toISOString();
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error("Inbound receivedAt is invalid");
  return {
    connectorId: record.connectorId as string,
    accountId: record.accountId as string,
    deliveryId: record.deliveryId as string,
    senderExternalId: record.senderExternalId as string,
    ...(typeof record.threadExternalId === "string" ? { threadExternalId: record.threadExternalId } : {}),
    ...(typeof record.conversationExternalId === "string" ? { conversationExternalId: record.conversationExternalId } : {}),
    text: record.text as string,
    attachmentUrls,
    receivedAt,
    ...(typeof record.rawDigest === "string" ? { rawDigest: record.rawDigest } : {}),
  };
}

function toReceipt(row: Record<string, unknown>): DeliveryReceipt {
  return {
    connectorId: row.connector_id as string, accountId: row.account_id as string,
    deliveryId: row.delivery_id as string, status: row.status as DeliveryReceipt["status"],
    ...(row.run_id ? { runId: row.run_id as string } : {}),
    ...(row.reply_external_id ? { replyExternalId: row.reply_external_id as string } : {}),
    ...(row.error_code ? { errorCode: row.error_code as string } : {}),
    receivedAt: row.received_at as string, updatedAt: row.updated_at as string,
  };
}

async function jsonResponse(response: Response, connector: string): Promise<unknown> {
  if (!response.ok) {
    const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
    throw new ConnectorError(
      response.status === 429 ? "rate_limited" : "connector_http_error",
      `${connector} returned HTTP ${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      Number.isFinite(retryAfter) ? retryAfter * 1_000 : undefined,
    );
  }
  try { return await response.json(); }
  catch { throw new ConnectorError("connector_invalid_response", `${connector} returned invalid JSON`, false); }
}

async function safeFetch(fetcher: typeof globalThis.fetch, url: string, init: RequestInit, connector: string): Promise<Response> {
  try { return await fetcher(url, init); }
  catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("connector_network_error", `${connector} request failed`, true);
  }
}

function validateOutbound(message: OutboundMessage, maxTextLength: number): void {
  if (!message.accountId.trim() || !message.conversationExternalId.trim()) {
    throw new ConnectorError("message_invalid", "Connector account and conversation are required", false);
  }
  if (!message.text.trim() || message.text.length > maxTextLength) {
    throw new ConnectorError("message_invalid", `Message text must contain 1-${maxTextLength} characters`, false);
  }
}

function recordAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
