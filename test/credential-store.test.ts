import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OsSecretStore, type CommandRunner } from "@lite-harness/credential-store";

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
    const runner: CommandRunner = async (_command, args, input) => {
      const script = args.at(-1) ?? "";
      return script.includes("::Protect(")
        ? { code: 0, stdout: ciphertext, stderr: "" }
        : { code: 0, stdout: Buffer.from(input === ciphertext ? "second-secret" : "unexpected").toString("base64"), stderr: "" };
    };
    const store = new OsSecretStore({ platform: "win32", windowsPath: path, runner });
    await store.set("profile", "first-secret");
    await store.set("profile", "second-secret");
    expect(readFileSync(path, "utf8")).not.toContain("second-secret");
    await expect(store.get("profile")).resolves.toBe("second-secret");
    await expect(store.delete("profile")).resolves.toBe(true);
    await expect(store.get("profile")).resolves.toBeUndefined();
  });
});
