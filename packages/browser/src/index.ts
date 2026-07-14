import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

export interface BrowserOwner {
  appId: string;
  tenantId: string;
  userId: string;
  runId: string;
}

export interface BrowserNetworkPolicy {
  allowedOrigins?: readonly string[];
  allowPrivateNetworks?: boolean;
}

export async function assertBrowserUrlAllowed(
  rawUrl: string,
  policy: BrowserNetworkPolicy,
  resolver: (hostname: string) => Promise<readonly string[]> = defaultResolver,
): Promise<URL> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Browser URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Browser URL must not contain credentials");
  if (policy.allowedOrigins && !policy.allowedOrigins.includes(url.origin)) throw new Error(`Browser origin is not allowed: ${url.origin}`);
  const addresses = isIP(url.hostname) ? [url.hostname] : await resolver(url.hostname);
  if (addresses.length === 0) throw new Error("Browser hostname did not resolve");
  if (!policy.allowPrivateNetworks && addresses.some(isPrivateAddress)) {
    throw new Error("Browser navigation to private or metadata networks is denied");
  }
  return url;
}

export class BrowserSessionBroker {
  readonly #sessions = new Map<string, { owner: BrowserOwner; expiresAt: number; tabs: Set<string> }>();

  create(owner: BrowserOwner, ttlMs = 60_000): string {
    const id = `browser_${randomUUID().replaceAll("-", "")}`;
    this.#sessions.set(id, { owner: { ...owner }, expiresAt: Date.now() + ttlMs, tabs: new Set() });
    return id;
  }

  assertOwner(sessionId: string, owner: BrowserOwner): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) throw new Error("Browser session is unavailable or expired");
    if (Object.keys(owner).some((key) => owner[key as keyof BrowserOwner] !== session.owner[key as keyof BrowserOwner])) {
      throw new Error("Browser session does not belong to this run");
    }
  }

  attachTab(sessionId: string, owner: BrowserOwner, tabId: string): void {
    this.assertOwner(sessionId, owner);
    this.#sessions.get(sessionId)?.tabs.add(tabId);
  }

  close(sessionId: string, owner: BrowserOwner): void {
    this.assertOwner(sessionId, owner);
    this.#sessions.delete(sessionId);
  }

  get activeCount(): number {
    return this.#sessions.size;
  }
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = -1, b = -1] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
