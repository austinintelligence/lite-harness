import { describe, expect, it } from "vitest";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";

const image = process.env.LITE_HARNESS_TEST_DOCKER_IMAGE;
const suite = image ? describe : describe.skip;

suite("Docker runtime integration", () => {
  it("persists a named-volume workspace across containers and restores an archive", async () => {
    const workspaceId = `integration-${Date.now()}`;
    const runtime = new DockerToolRuntime({ image: image as string });
    try {
      const write = await runtime.execute({
        workspaceId,
        call: { id: "write-1", name: "write_file", arguments: { path: "hello.txt", content: "hello docker" } },
      });
      expect(write.ok).toBe(true);
      const archive = await runtime.exportWorkspace(workspaceId);
      await runtime.execute({
        workspaceId,
        call: { id: "write-2", name: "write_file", arguments: { path: "hello.txt", content: "changed" } },
      });
      await runtime.importWorkspace(workspaceId, archive);
      const restored = await runtime.execute({
        workspaceId,
        call: { id: "read-1", name: "read_file", arguments: { path: "hello.txt" } },
      });
      expect(restored.content).toBe("hello docker");
    } finally {
      await runtime.removeWorkspace(workspaceId);
    }
  }, 60_000);
});
