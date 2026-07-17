import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dockerMaintenanceHardeningArgs } from "@lite-harness/runtime-docker";

const requiredImages = [
  "LITE_HARNESS_TEST_DOCKER_IMAGE",
  "LITE_HARNESS_TEST_MCP_IMAGE",
  "LITE_HARNESS_TEST_BROWSER_IMAGE",
] as const;

describe("required real runtime qualification", () => {
  it("A07-MAINTENANCE-HARDENING-ARGS keeps maintenance containers on the bounded default Docker profile", () => {
    const args = dockerMaintenanceHardeningArgs({ memory: "48m", cpus: "0.25", pidsLimit: 32 }, { user: "1000:1000" });
    expect(args).toEqual(expect.arrayContaining([
      "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges=true", "--pids-limit", "32",
      "--memory", "48m", "--memory-swap", "48m", "--cpus", "0.25",
      "--ulimit", "nofile=1024:1024", "--user", "1000:1000",
    ]));
    expect(args).not.toContain("seccomp=default");
  });

  it("BD-055-REGRESSION fails closed unless every Docker and browser lane has immutable, locally available inputs", () => {
    expect(process.env.LITE_HARNESS_REAL_RUNTIME_TEST).toBe("1");
    for (const name of requiredImages) {
      const image = process.env[name];
      expect(image, `${name} must be supplied by the required release lane`).toMatch(
        /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/i,
      );
      const inspected = spawnSync("docker", ["image", "inspect", image!], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(inspected.status, `${name} must resolve to a local candidate image`).toBe(0);
    }

    const script = readFileSync(new URL("../scripts/check-real-runtime.mjs", import.meta.url), "utf8");
    expect(script).toContain("report.numPendingTests");
    expect(script).toContain("report.numTodoTests");
    expect(script).toContain("skips === 0");
    expect(script).toContain("invalidRequiredFiles.length === 0");
    expect(script).toContain("everyRequiredRuntimeFileExecuted");
    expect(script).not.toContain("describe.skip");

    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toContain("required-real-runtime:");
    expect(workflow).toContain("provider-evidence:");
    expect(workflow).toContain("candidate-evidence-truth:");
  });
});
