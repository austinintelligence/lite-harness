import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import type { InternalPrincipal, MintRunTokenRequest, MintRunTokenResponse, RevokeTokenResponse, RunBudget } from "@lite-harness/contracts";

const KEY_BYTES = 64;
const MAX_TOKEN_BYTES = 4_096;
const RUN_TOKEN_SCOPES = new Set([
  "runs:create", "runs:read", "runs:cancel", "runs:steer", "events:read",
  "approvals:resolve", "artifacts:publish", "artifacts:read",
]);

export const DEFAULT_APP_SCOPES = Object.freeze([
  "tokens:mint", "tokens:revoke", "runs:create", "runs:read", "runs:cancel", "runs:steer", "events:read",
  "approvals:resolve", "sessions:read", "artifacts:publish", "artifacts:read",
  "agents:write", "agents:read", "workspaces:write", "workspaces:read",
]);

export interface StoredAccessToken {
  id: string;
  lookupHash: string;
  secretHash: string;
  salt: string;
  type: "app" | "run";
  appId: string;
  tenantId: string;
  userId: string;
  scopes: string[];
  replayPolicy: "multi_use" | "resource_bound_multi_use";
  agentId?: string;
  workspaceId?: string;
  budgetCeiling?: Partial<RunBudget>;
  issuedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  keyGeneration: number;
}

export interface AccessTokenStore {
  getByLookupHash(lookupHash: string): StoredAccessToken | undefined;
  getById(id: string): StoredAccessToken | undefined;
  latestAppKeyGeneration(appId: string, tenantId: string, userId: string): number;
  put(record: StoredAccessToken): void;
  rotateApp(record: StoredAccessToken, revokedAt: string): void;
  revoke(id: string, revokedAt: string): boolean;
  close(): void;
}

export class AccessTokenService {
  constructor(private readonly store: AccessTokenStore) {}

  async ensureBootstrapAppToken(
    token: string,
    binding: { appId: string; tenantId: string; userId: string; scopes: string[] },
  ): Promise<StoredAccessToken> {
    validateToken(token);
    const lookupHash = lookup(token);
    const existing = this.store.getByLookupHash(lookupHash);
    if (existing) {
      if (!isActive(existing) || !await verifySecret(token, existing) || existing.type !== "app" ||
          existing.appId !== binding.appId || existing.tenantId !== binding.tenantId || existing.userId !== binding.userId ||
          !sameStrings(existing.scopes, binding.scopes)) {
        throw new Error("Configured bootstrap app token conflicts with its persisted binding");
      }
      return existing;
    }
    const record = await createRecord(token, {
      id: `tok_${randomUUID().replaceAll("-", "")}`,
      lookupHash,
      type: "app",
      ...binding,
      replayPolicy: "multi_use",
      issuedAt: new Date().toISOString(),
      keyGeneration: this.store.latestAppKeyGeneration(binding.appId, binding.tenantId, binding.userId) + 1,
    });
    this.store.rotateApp(record, record.issuedAt);
    return record;
  }

  async authenticate(token: string): Promise<InternalPrincipal | undefined> {
    if (!isValidToken(token)) return undefined;
    const record = this.store.getByLookupHash(lookup(token));
    if (!record || !isActive(record)) return undefined;
    if (!await verifySecret(token, record)) return undefined;
    return {
      appId: record.appId,
      tenantId: record.tenantId,
      userId: record.userId,
      scopes: [...record.scopes],
      tokenId: record.id,
      tokenType: record.type,
      replayPolicy: record.replayPolicy,
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.budgetCeiling ? { budgetCeiling: { ...record.budgetCeiling } } : {}),
    };
  }

  async mintRunToken(parent: InternalPrincipal, request: MintRunTokenRequest): Promise<MintRunTokenResponse> {
    if (parent.tokenType !== "app" || !parent.tokenId) throw new Error("Only an authenticated app credential can mint run tokens");
    const persistedParent = this.store.getById(parent.tokenId);
    if (!persistedParent || persistedParent.type !== "app" || !isActive(persistedParent) ||
        persistedParent.appId !== parent.appId || persistedParent.tenantId !== parent.tenantId ||
        persistedParent.userId !== parent.userId || !sameStrings(persistedParent.scopes, parent.scopes)) {
      throw new Error("App credential binding is no longer active");
    }
    const scopes = [...new Set(request.scopes)].sort();
    if (!scopes.every((scope) => parent.scopes.includes(scope))) throw new Error("Run-token scopes must be a subset of the app credential");
    if (!scopes.every((scope) => RUN_TOKEN_SCOPES.has(scope))) throw new Error("Run token requested an app-administration scope");
    if (parent.agentId && request.agentId && request.agentId !== parent.agentId) throw new Error("Run token cannot expand the parent agent binding");
    if (parent.workspaceId && request.workspaceId && request.workspaceId !== parent.workspaceId) throw new Error("Run token cannot expand the parent workspace binding");
    if (request.budgetCeiling && parent.budgetCeiling && !budgetWithin(request.budgetCeiling, parent.budgetCeiling)) {
      throw new Error("Run token cannot expand the parent budget ceiling");
    }
    const agentId = request.agentId ?? parent.agentId;
    const workspaceId = request.workspaceId ?? parent.workspaceId;
    const budgetCeiling = parent.budgetCeiling
      ? { ...parent.budgetCeiling, ...(request.budgetCeiling ?? {}) }
      : request.budgetCeiling;
    const token = `lhr_${randomBytes(32).toString("base64url")}`;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + (request.ttlSeconds ?? 900) * 1_000).toISOString();
    const record = await createRecord(token, {
      id: `tok_${randomUUID().replaceAll("-", "")}`,
      lookupHash: lookup(token),
      type: "run",
      appId: parent.appId,
      tenantId: parent.tenantId,
      userId: parent.userId,
      scopes,
      replayPolicy: "resource_bound_multi_use",
      ...(agentId ? { agentId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(budgetCeiling ? { budgetCeiling } : {}),
      issuedAt: issuedAt.toISOString(),
      expiresAt,
      keyGeneration: 1,
    });
    this.store.put(record);
    return { token, tokenId: record.id, expiresAt, scopes, replayPolicy: "resource_bound_multi_use" };
  }

  revoke(parent: InternalPrincipal, tokenId: string): RevokeTokenResponse | undefined {
    if (parent.tokenType !== "app" || !parent.tokenId) throw new Error("Only an authenticated app credential can revoke run tokens");
    const persistedParent = this.store.getById(parent.tokenId);
    if (!persistedParent || persistedParent.type !== "app" || !isActive(persistedParent) ||
        persistedParent.appId !== parent.appId || persistedParent.tenantId !== parent.tenantId ||
        persistedParent.userId !== parent.userId || !sameStrings(persistedParent.scopes, parent.scopes)) {
      throw new Error("App credential binding is no longer active");
    }
    const target = this.store.getById(tokenId);
    if (!target || target.type !== "run" || target.appId !== parent.appId ||
        target.tenantId !== parent.tenantId || target.userId !== parent.userId) return undefined;
    return this.store.revoke(tokenId, new Date().toISOString()) ? { tokenId, revoked: true } : undefined;
  }
}

async function createRecord(
  token: string,
  record: Omit<StoredAccessToken, "secretHash" | "salt">,
): Promise<StoredAccessToken> {
  const salt = randomBytes(16);
  const hash = await derive(token, salt);
  return { ...record, salt: salt.toString("base64"), secretHash: hash.toString("base64") };
}

async function verifySecret(token: string, record: StoredAccessToken): Promise<boolean> {
  try {
    const expected = Buffer.from(record.secretHash, "base64");
    const actual = await derive(token, Buffer.from(record.salt, "base64"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function derive(token: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(token, salt, KEY_BYTES, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

function lookup(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateToken(token: string): void {
  if (!isValidToken(token)) throw new Error("Access token must be a bounded single-line secret");
}

function isValidToken(token: string): boolean {
  const bytes = Buffer.byteLength(token);
  return bytes >= 16 && bytes <= MAX_TOKEN_BYTES && !/[\r\n\0]/.test(token);
}

function isActive(record: StoredAccessToken): boolean {
  if (record.revokedAt) return false;
  if (!record.expiresAt) return true;
  const expiry = Date.parse(record.expiresAt);
  return Number.isFinite(expiry) && expiry > Date.now();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function budgetWithin(requested: Partial<RunBudget>, parent: Partial<RunBudget>): boolean {
  return Object.entries(requested).every(([key, value]) => {
    const ceiling = parent[key as keyof RunBudget];
    return ceiling === undefined || (typeof value === "number" && value <= ceiling);
  });
}
