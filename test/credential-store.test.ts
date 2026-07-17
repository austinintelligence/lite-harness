import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore, EncryptedFileSecretStore, OsSecretStore, type CommandRunner } from "@lite-harness/credential-store";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("OS credential store", () => {
  it("passes Linux secrets over stdin and keeps lookup scoped by service/account", async () => {
    const calls: Array<{ command: string; args: readonly string[]; input?: string }> = [];
    const runner: CommandRunner = vi.fn(async (command, args, input) => {
      calls.push({ command, args, ...(input === undefined ? {} : { input }) });
      if (args[0] === "lookup") return { code: 0, stdout: "stored-secret\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const store = new OsSecretStore({ platform: "linux", service: "lite-test", runner });
    await store.set("provider.profile", "stored-secret");
    expect(calls[0]?.args).not.toContain("stored-secret");
    expect(calls[0]?.input).toBe("stored-secret");
    await expect(store.get("provider.profile")).resolves.toBe("stored-secret");
    await expect(store.delete("provider.profile")).resolves.toBe(true);
  });

  it("stores only DPAPI ciphertext in the Windows index and updates it safely", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-credentials-")); cleanup.push(directory);
    const path = join(directory, "credentials.json");
    const ciphertext = Buffer.from("dpapi-ciphertext").toString("base64");
    const scripts: string[] = [];
    const runner: CommandRunner = async (_command, args, input) => {
      const script = args.at(-1) ?? "";
      scripts.push(script);
      return script.includes("::Protect(")
        ? { code: 0, stdout: ciphertext, stderr: "" }
        : { code: 0, stdout: Buffer.from(input === ciphertext ? "second-secret" : "unexpected").toString("base64"), stderr: "" };
    };
    const store = new OsSecretStore({ platform: "win32", windowsPath: path, runner });
    await store.set("profile", "first-secret");
    await store.set("profile", "second-secret");
    expect(scripts[0]).toContain("Add-Type -AssemblyName System.Security");
    expect(readFileSync(path, "utf8")).not.toContain("second-secret");
    await expect(store.get("profile")).resolves.toBe("second-secret");
    await expect(store.delete("profile")).resolves.toBe(true);
    await expect(store.get("profile")).resolves.toBeUndefined();
  });

  it("serializes updates from independent Windows store instances without losing keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-credentials-concurrent-")); cleanup.push(directory);
    const path = join(directory, "credentials.json");
    const ciphertext = Buffer.from("ciphertext").toString("base64");
    const runner: CommandRunner = async (_command, args) => {
      if (args.at(-1)?.includes("::Protect(")) await new Promise((resolve) => setTimeout(resolve, 10));
      return { code: 0, stdout: ciphertext, stderr: "" };
    };
    const first = new OsSecretStore({ platform: "win32", windowsPath: path, runner });
    const second = new OsSecretStore({ platform: "win32", windowsPath: path, runner });
    await Promise.all([first.set("first", "one"), second.set("second", "two")]);
    const source = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(Object.keys(source).sort()).toEqual(["first", "second"]);
    expect(source.first).toBe(ciphertext);
    expect(source.second).toBe(ciphertext);
  });

  it("atomically creates one Windows credential across independent store instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-credentials-get-or-create-")); cleanup.push(directory);
    const path = join(directory, "credentials.json");
    const ciphertext = Buffer.from("ciphertext").toString("base64");
    let generated = 0;
    const runner: CommandRunner = async (_command, args) => {
      const script = args.at(-1) ?? "";
      if (script.includes("::Protect(")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { code: 0, stdout: ciphertext, stderr: "" };
      }
      return { code: 0, stdout: Buffer.from("token-1").toString("base64"), stderr: "" };
    };
    const first = new OsSecretStore({ platform: "win32", windowsPath: path, runner });
    const second = new OsSecretStore({ platform: "win32", windowsPath: path, runner });
    const create = () => { generated += 1; return `token-${generated}`; };

    const results = await Promise.all([
      first.getOrCreate("service.app-token", create),
      second.getOrCreate("service.app-token", create),
    ]);

    expect(generated).toBe(1);
    expect(results.map((result) => result.value)).toEqual(["token-1", "token-1"]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("uses an explicit encrypted recovery envelope without plaintext or lost concurrent updates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lite-recovery-credentials-")); cleanup.push(directory);
    const path = join(directory, "credentials.recovery.json");
    const first = new EncryptedFileSecretStore({ path, passphrase: "operator-recovery-passphrase" });
    const second = new EncryptedFileSecretStore({ path, passphrase: "operator-recovery-passphrase" });
    await Promise.all([first.set("first", "secret-one"), second.set("second", "secret-two")]);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("secret-one");
    expect(source).not.toContain("secret-two");
    await expect(first.get("first")).resolves.toBe("secret-one");
    await expect(second.get("second")).resolves.toBe("secret-two");
    await expect(new EncryptedFileSecretStore({ path, passphrase: "wrong-recovery-passphrase" }).get("first"))
      .rejects.toThrow(/could not be decrypted/);
    const selected = createCredentialStore(directory, { LITE_HARNESS_CREDENTIAL_RECOVERY_KEY: "operator-recovery-passphrase" });
    await selected.set("factory", "selected-secret");
    await expect(selected.get("factory")).resolves.toBe("selected-secret");
  });
});
