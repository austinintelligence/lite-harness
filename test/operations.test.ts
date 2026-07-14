import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installUserService, renderUserService } from "@lite-harness/operations";

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
});
