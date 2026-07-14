import { describe, expect, it } from "vitest";
import { InMemoryToolRuntime, validateWorkspacePath } from "@lite-harness/runtime";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";

describe("tool runtime policy", () => {
  it.each(["/etc/passwd", "../escape", "folder/../escape", "C:\\Windows\\file", "a//b"])(
    "rejects unsafe workspace path %s",
    (path) => {
      expect(() => validateWorkspacePath(path)).toThrow(/Unsafe workspace path/);
    },
  );

  it("allows a portable relative workspace path", () => {
    expect(() => validateWorkspacePath("src/example.ts")).not.toThrow();
  });

  it("requires Docker images to be pinned by digest", () => {
    expect(() => new DockerToolRuntime({ image: "alpine:latest" })).toThrow(/pinned by sha256/);
  });

  it("keeps in-memory workspaces isolated", async () => {
    const runtime = new InMemoryToolRuntime();
    await runtime.execute({
      workspaceId: "one",
      call: { id: "tool-1", name: "write_file", arguments: { path: "a.txt", content: "one" } },
    });
    expect(runtime.readFile("one", "a.txt")).toBe("one");
    expect(runtime.readFile("two", "a.txt")).toBeUndefined();
  });
});
