import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundEnvelope {
  connectorId: string;
  accountId: string;
  deliveryId: string;
  senderExternalId: string;
  threadExternalId?: string;
  text: string;
  attachmentUrls: readonly string[];
  receivedAt: string;
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

export function verifyHmacSha256(body: Buffer, signature: string, secret: Buffer): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signature.replace(/^sha256=/, "").toLowerCase();
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function normalizeInbound(value: unknown): InboundEnvelope {
  if (!value || typeof value !== "object") throw new Error("Inbound envelope must be an object");
  const record = value as Record<string, unknown>;
  for (const field of ["connectorId", "accountId", "deliveryId", "senderExternalId", "text"] as const) {
    if (typeof record[field] !== "string" || !(record[field] as string).trim()) throw new Error(`Inbound ${field} is required`);
  }
  const attachmentUrls = record.attachmentUrls ?? [];
  if (!Array.isArray(attachmentUrls) || !attachmentUrls.every((item) => typeof item === "string")) {
    throw new Error("Inbound attachmentUrls must be a string array");
  }
  return {
    connectorId: record.connectorId as string,
    accountId: record.accountId as string,
    deliveryId: record.deliveryId as string,
    senderExternalId: record.senderExternalId as string,
    ...(typeof record.threadExternalId === "string" ? { threadExternalId: record.threadExternalId } : {}),
    text: record.text as string,
    attachmentUrls,
    receivedAt: typeof record.receivedAt === "string" ? record.receivedAt : new Date().toISOString(),
  };
}
