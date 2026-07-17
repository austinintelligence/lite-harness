import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessTokenService } from "@lite-harness/auth";
import { SqliteAccessTokenStore } from "@lite-harness/auth-sqlite";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("opaque access-token service", () => {
  it("BD-001-REGRESSION persists only a strong hash and resolves server-owned identity", async () => {
    const root = temporaryRoot();
    const store = new SqliteAccessTokenStore(join(root, "auth.db"));
    const service = new AccessTokenService(store);
    const secret = "bootstrap-app-token-secret";
    const record = await service.ensureBootstrapAppToken(secret, {
      appId: "app-a", tenantId: "tenant-a", userId: "user-a", scopes: ["runs:create", "tokens:mint"],
    });
    expect(record.secretHash).not.toContain(secret);
    expect(record.lookupHash).not.toContain(secret);
    expect(await service.authenticate(secret)).toMatchObject({
      appId: "app-a", tenantId: "tenant-a", userId: "user-a", scopes: ["runs:create", "tokens:mint"], tokenType: "app",
    });
    expect(await service.authenticate("bootstrap-app-token-wrong")).toBeUndefined();
    store.close();
  });

  it("mints bounded short-lived tokens without allowing scope or resource expansion", async () => {
    const root = temporaryRoot();
    const store = new SqliteAccessTokenStore(join(root, "auth.db"));
    const service = new AccessTokenService(store);
    await service.ensureBootstrapAppToken("bootstrap-app-token-secret", {
      appId: "app-a", tenantId: "tenant-a", userId: "user-a", scopes: ["runs:create", "tokens:mint"],
    });
    const parent = await service.authenticate("bootstrap-app-token-secret");
    expect(parent).toBeDefined();
    const minted = await service.mintRunToken(parent!, {
      scopes: ["runs:create"], ttlSeconds: 60, agentId: "coder", workspaceId: "workspace-a",
      budgetCeiling: { maxTurns: 2, maxCostUsd: 1 },
    });
    expect(minted.token).toMatch(/^lhr_/);
    expect(await service.authenticate(minted.token)).toMatchObject({
      tokenType: "run", scopes: ["runs:create"], agentId: "coder", workspaceId: "workspace-a",
      budgetCeiling: { maxTurns: 2, maxCostUsd: 1 }, replayPolicy: "resource_bound_multi_use",
    });
    await expect(service.mintRunToken(parent!, { scopes: ["admin"] })).rejects.toThrow(/subset/);
    await expect(service.mintRunToken(parent!, { scopes: ["tokens:mint"] })).rejects.toThrow(/administration/);
    expect(service.revoke(parent!, minted.tokenId)).toEqual({ tokenId: minted.tokenId, revoked: true });
    expect(await service.authenticate(minted.token)).toBeUndefined();
    store.close();
  });

  it("supports an explicit bootstrap scope expansion without weakening strict callers", async () => {
    const root = temporaryRoot();
    const store = new SqliteAccessTokenStore(join(root, "auth.db"));
    const service = new AccessTokenService(store);
    const secret = "bootstrap-app-token-migration";
    const binding = { appId: "app-a", tenantId: "tenant-a", userId: "user-a", scopes: ["runs:create"] };
    await service.ensureBootstrapAppToken(secret, binding);
    await expect(service.ensureBootstrapAppToken(secret, {
      ...binding, scopes: ["runs:create", "providers:read"],
    })).rejects.toThrow(/conflicts/);
    await expect(service.ensureBootstrapAppToken(secret, {
      ...binding, scopes: ["runs:create", "providers:read"],
    }, { allowScopeExpansion: true })).resolves.toMatchObject({ scopes: ["runs:create", "providers:read"] });
    expect(await service.authenticate(secret)).toMatchObject({ scopes: ["runs:create", "providers:read"] });
    store.close();
  });

  it("rotates a bootstrap app credential atomically and rejects the superseded token", async () => {
    const root = temporaryRoot();
    const store = new SqliteAccessTokenStore(join(root, "auth.db"));
    const service = new AccessTokenService(store);
    const binding = {
      appId: "app-a", tenantId: "tenant-a", userId: "user-a", scopes: ["runs:create", "tokens:mint"],
    };
    const first = await service.ensureBootstrapAppToken("bootstrap-app-token-first", binding);
    const second = await service.ensureBootstrapAppToken("bootstrap-app-token-second", binding);
    expect(second.keyGeneration).toBe(first.keyGeneration + 1);
    expect(await service.authenticate("bootstrap-app-token-first")).toBeUndefined();
    expect(await service.authenticate("bootstrap-app-token-second")).toMatchObject({ tokenId: second.id });
    store.close();
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lite-auth-"));
  roots.push(root);
  return root;
}
