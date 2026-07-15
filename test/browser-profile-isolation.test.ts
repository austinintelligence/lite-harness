import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedBrowserProfileStore } from "@lite-harness/browser";

describe("browser profile ownership", () => {
  it("BD-009-REGRESSION preserves same-named encrypted profiles for distinct owners", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-browser-owner-"));
    try {
      const store = new EncryptedBrowserProfileStore(directory, Buffer.alloc(32, 7));
      const ownerA = { appId: "app", tenantId: "tenant-a", userId: "user" };
      const ownerB = { appId: "app", tenantId: "tenant-b", userId: "user" };
      await store.save("default", ownerA, "profile-a");
      await store.save("default", ownerB, "profile-b");
      await expect(store.load("default", ownerA)).resolves.toBe("profile-a");
      await expect(store.load("default", ownerB)).resolves.toBe("profile-b");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
