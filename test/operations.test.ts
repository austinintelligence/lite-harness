import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installUserService, RedactedStreamBuffer, redactServiceLog, renderUserService, RotatingLogSink } from "@lite-harness/operations";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("cross-platform user services", () => {
  it("renders least-privilege service definitions without embedding tokens", () => {
    const root = "C:\\Lite Harness";
    const dataDir = "C:\\Lite Data";
    const windows = renderUserService({ root, dataDir, nodePath: "C:\\node.exe", platform: "win32", home: "C:\\Users\\test" });
    expect(windows.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(windows.content).toContain("--data-dir");
    expect(windows.content).not.toMatch(/internal-token|app-token/i);

    const linux = renderUserService({ root: "/opt/lite harness", dataDir: "/home/test/.lite", nodePath: "/usr/bin/node", platform: "linux", home: "/home/test" });
    expect(linux.content).toContain("NoNewPrivileges=true");
    expect(linux.content).toContain("Restart=on-failure");

    const mac = renderUserService({ root: "/Applications/Lite Harness", dataDir: "/Users/test/.lite", nodePath: "/usr/local/bin/node", platform: "darwin", home: "/Users/test" });
    expect(mac.content).toContain("dev.lite-harness");
    expect(mac.content).toContain("<key>KeepAlive</key>");
  });

  it("installs through the native user service manager", async () => {
    const home = mkdtempSync(join(tmpdir(), "lite-service-")); cleanup.push(home);
    const runner = vi.fn(async () => ({ code: 0, stdout: "ok" }));
    const installed = await installUserService({
      root: "/opt/lite", dataDir: join(home, "data"), nodePath: "/usr/bin/node", platform: "linux", home, runner,
    });
    expect(readFileSync(installed.path, "utf8")).toContain("ExecStart=");
    expect(runner.mock.calls).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", "lite-harness.service"]],
    ]);
  });

  it("redacts credentials from durable service logs and launcher relay text", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-service-logs-")); cleanup.push(root);
    const path = join(root, "service.jsonl");
    const raw = [
      "Authorization: Bearer abcdefghijklmnop",
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      "password=tiny",
      "credential=service-account-value",
      "Cookie: session=private-cookie-value; refresh=private-refresh-value",
      '{"cookie":"json-cookie-value"}',
      "api_key=sk-abcdefghijklmnopqrstuvwxyz",
    ].join("\n");
    const redacted = redactServiceLog(raw);
    for (const secret of ["abcdefghijklmnop", "dXNlcjpwYXNzd29yZA==", "tiny", "service-account-value", "private-cookie-value", "private-refresh-value", "json-cookie-value", "sk-abcdefghijklmnopqrstuvwxyz"]) {
      expect(redacted).not.toContain(secret);
    }

    const sink = new RotatingLogSink(path);
    sink.write("manager", "stderr", raw);
    sink.flush("manager", "stderr");
    const persisted = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message: string });
    expect(persisted.map((line) => line.message).join("")).toBe(redacted);
    expect(persisted.map((line) => line.message).join("").match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("redacts split credentials and preserves split UTF-8 in durable and relayed streams", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-service-streams-")); cleanup.push(root);
    const path = join(root, "service.jsonl");
    const sink = new RotatingLogSink(path);
    sink.write("manager", "stderr", "password=");
    sink.write("manager", "stderr", "split-super-secret\n");
    const unicode = Buffer.from("message=ready 🙂\n", "utf8");
    const split = unicode.indexOf(Buffer.from("🙂")) + 2;
    sink.write("manager", "stderr", unicode.subarray(0, split));
    sink.write("manager", "stderr", unicode.subarray(split));
    sink.flush("manager", "stderr");
    const durable = readFileSync(path, "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { message: string }).message).join("");
    expect(durable).not.toContain("split-super-secret");
    expect(durable).toContain("message=ready 🙂");

    const relayed: string[] = [];
    const relay = new RedactedStreamBuffer((text) => relayed.push(text));
    relay.write("credential=");
    relay.write("split-relay-secret\n");
    relay.write(unicode.subarray(0, split));
    relay.write(unicode.subarray(split));
    relay.end();
    expect(relayed.join("")).not.toContain("split-relay-secret");
    expect(relayed.join("")).toContain("message=ready 🙂");
  });

  it("discards oversized logical lines until newline without leaking their tails", () => {
    const emitted: string[] = [];
    const stream = new RedactedStreamBuffer((text) => emitted.push(text), 16);
    stream.write("password=");
    stream.write("very-long-secret");
    stream.write("-discarded-tail\n");
    stream.write("token=abc\n");
    stream.write("credential=");
    stream.write("another-long-secret");
    stream.end("-discarded-at-end");

    const output = emitted.join("");
    expect(output.match(/\[REDACTED OVERSIZED LOG LINE\]/g)).toHaveLength(2);
    expect(output).toContain("token=[REDACTED]\n");
    for (const secret of ["very-long-secret", "discarded-tail", "another-long-secret", "discarded-at-end"]) {
      expect(output).not.toContain(secret);
    }
  });
});
