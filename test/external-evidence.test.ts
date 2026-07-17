import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requiredExternalGateAuthorities } from "../scripts/assemble-ci-evidence.mjs";
import { externalPlatformGates, externalPlatformGateNames, validateExternalPlatform } from "../scripts/evidence-external.mjs";
import { validateWorkflowStructure } from "../scripts/check-workflows.mjs";

describe("external platform evidence producer", () => {
  it("declares every required platform lane with a dedicated runner contract", () => {
    expect(externalPlatformGateNames).toEqual([
      "linuxRootful", "linuxRootless", "linuxArm64", "macosIntelDockerDesktop",
      "macosAppleSiliconDockerDesktop", "windows11DockerDesktopWsl2",
    ]);
    for (const gate of externalPlatformGateNames) {
      expect(externalPlatformGates[gate].runnerLabels.length).toBeGreaterThanOrEqual(4);
      expect(requiredExternalGateAuthorities[gate].ciJob).toBe("rootless-product-evidence");
    }
  });

  it("fails closed when the Docker mode does not match the declared lane", () => {
    const facts = (os: string, architecture: string) => ({ platform: { os, architecture } });
    const rootlessInfo = { OSType: "linux", SecurityOptions: ["name=rootless"], OperatingSystem: "Ubuntu" };
    const rootfulInfo = { OSType: "linux", SecurityOptions: ["name=seccomp"], OperatingSystem: "Ubuntu" };
    expect(validateExternalPlatform("linuxRootless", facts("linux", "x64"), rootfulInfo)).toContain("Docker must be running in rootless mode");
    expect(validateExternalPlatform("linuxRootful", facts("linux", "x64"), rootlessInfo)).toContain("Docker rootless mode is not valid for this gate");
  });

  it("requires Docker Desktop identity on desktop lanes", () => {
    const facts = { platform: { os: "darwin", architecture: "arm64" } };
    const info = { OSType: "linux", SecurityOptions: [], OperatingSystem: "Docker Engine" };
    expect(validateExternalPlatform("macosAppleSiliconDockerDesktop", facts, info)).toContain("Docker Desktop must identify itself in Docker info");
  });

  it("wires the producer into the package and pinned external workflow", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const workflow = readFileSync(".github/workflows/external-platform-evidence.yml", "utf8");
    const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(manifest.scripts["evidence:external"]).toBe("node scripts/evidence-external.mjs");
    expect(validateWorkflowStructure(workflow, "external-platform-evidence.yml")).toEqual([]);
    expect(workflow).toContain("evidencePath: evidence/external/linux-rootful.json");
    expect(workflow).toContain("--evidence ${{ matrix.evidencePath }}");
    expect(ciWorkflow).toContain("external_platform_gate");
    expect(ciWorkflow).toContain("uses: ./.github/workflows/external-platform-evidence.yml");
    expect(ciWorkflow).toContain("--include-external");
  });

  it("rejects matrix filtering at job scope and requires step-level gate filtering", () => {
    const broken = `jobs:\n  rootless-product-evidence:\n    if: \${{ inputs.gate == matrix.gate }}\n    strategy:\n      matrix:\n        include:\n          - gate: linuxRootful\n    steps:\n      - run: pnpm evidence:external --gate \${{ matrix.gate }}`;
    expect(validateWorkflowStructure(broken, "external-platform-evidence.yml")).toContain(
      "external-platform-evidence.yml: matrix filtering must not use matrix in a job-level if",
    );
  });

  it("refuses to run locally before touching Docker", () => {
    const result = spawnSync(process.execPath, [resolve("scripts", "evidence-external.mjs"), "--gate", "linuxRootless"], {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_ACTIONS: undefined },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("External platform evidence is CI-only");
  });
});
