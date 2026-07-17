import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecoveryBundle, restoreRecoveryBundle } from "@lite-harness/workspace";

describe("operator recovery bundles", () => {
  it("A15-RECOVERY-BUNDLE-ROUNDTRIP encrypts, authenticates, and restores a clean installation", () => {
    const parent = mkdtempSync(join(tmpdir(), "lite-recovery-bundle-"));
    try {
      const key = randomBytes(32);
      const bundle = createRecoveryBundle([
        { path: "config/runtime.json", data: Buffer.from('{"mode":"alpha"}') },
        { path: "manager/lite-harness.db", data: Buffer.from("sqlite-placeholder") },
      ], key);
      expect(bundle.toString("utf8")).not.toContain("sqlite-placeholder");

      const target = join(parent, "installation");
      const result = restoreRecoveryBundle(bundle, key, target);
      expect(result.bundleId).toMatch(/^[a-f0-9]{32}$/);
      expect(result.restoredPaths).toEqual(["config/runtime.json", "manager/lite-harness.db"]);
      expect(readFileSync(join(target, "config/runtime.json"), "utf8")).toBe('{"mode":"alpha"}');
      expect(readFileSync(join(target, "manager/lite-harness.db"), "utf8")).toBe("sqlite-placeholder");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects unsafe paths, wrong keys, tampering, and overwrite restores", () => {
    const parent = mkdtempSync(join(tmpdir(), "lite-recovery-bundle-integrity-"));
    try {
      const key = randomBytes(32);
      expect(() => createRecoveryBundle([{ path: "../escape", data: Buffer.from("no") }], key)).toThrow(/Unsafe workspace path/);
      const bundle = createRecoveryBundle([{ path: "state.json", data: Buffer.from("state") }], key);
      expect(() => restoreRecoveryBundle(bundle, randomBytes(32), join(parent, "wrong-key"))).toThrow(/authentication failed/);

      const tampered = Buffer.from(bundle);
      tampered[tampered.length - 1] ^= 0xff;
      expect(() => restoreRecoveryBundle(tampered, key, join(parent, "tampered"))).toThrow(/authentication failed/);

      const existing = join(parent, "existing");
      mkdirSync(existing);
      writeFileSync(join(existing, "keep.txt"), "keep");
      expect(() => restoreRecoveryBundle(bundle, key, existing)).toThrow(/clean, non-existent/);
      expect(existsSync(join(existing, "keep.txt"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
