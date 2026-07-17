import { describe, expect, it } from "vitest";
import { dockerRestartBlockers, type RunningDockerContainer } from "./support/docker-restart-guard.js";

describe("A09 Docker restart guard", () => {
  it("ignores only the BuildKit infrastructure container left by an image build", () => {
    const buildkit: RunningDockerContainer = {
      id: "buildkit-id",
      name: "buildx_buildkit_desktop-linux",
      image: "moby/buildkit:buildx-stable-1",
      labels: "desktop.docker.io/ports.scheme=v2",
    };
    expect(dockerRestartBlockers([buildkit])).toEqual([]);
  });

  it("keeps Lite, user, and lookalike containers as restart blockers", () => {
    const containers: RunningDockerContainer[] = [
      { id: "lite", name: "lite-harness-tool", image: "sha256:tool", labels: "" },
      { id: "user", name: "buildx_buildkit_not-buildkit", image: "alpine:latest", labels: "" },
      { id: "fake", name: "buildx_buildkit_fake", image: "moby/buildkit:custom", labels: "unrelated=true" },
    ];
    expect(dockerRestartBlockers(containers).map((container) => container.id)).toEqual(["lite", "user", "fake"]);
  });
});
