import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactPublishingRuntime, InMemoryToolRuntime, validateWorkspacePath } from "@lite-harness/runtime";
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

  it("treats registered bind workspaces as operator-owned and never deletes or restores over them", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-bind-"));
    try {
      const runtime = new DockerToolRuntime({
        image: `sha256:${"a".repeat(64)}`,
        resolveRegisteredWorkspace: (id) => id === "registered" ? root : undefined,
      });
      await expect(runtime.removeWorkspace("registered")).rejects.toThrow(/cannot be deleted/);
      await expect(runtime.importWorkspace("registered", Buffer.from("archive"))).rejects.toThrow(/cannot be replaced/);
    } finally { rmSync(root, { recursive: true, force: true }); }
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

  it("BD-035-REGRESSION publishes only bytes read from an owned workspace path", async () => {
    let published: Buffer | undefined;
    const workspaceRuntime = new InMemoryToolRuntime();
    const runtime = new ArtifactPublishingRuntime(workspaceRuntime, {
      publish: (params) => {
        published = params.data;
        return {
          id: "art_00000000000000000000000000000000",
          runId: params.runId,
          appId: params.principal.appId,
          tenantId: params.principal.tenantId,
          userId: params.principal.userId,
          workspaceId: params.workspaceId,
          path: params.path,
          mediaType: params.mediaType,
          sizeBytes: params.data.length,
          sha256: "digest",
          createdAt: new Date().toISOString(),
        };
      },
    });
    await workspaceRuntime.execute({
      workspaceId: "one",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      call: { id: "tool-write", name: "write_file", arguments: { path: "reports/result.txt", content: "owned output" } },
    });
    const result = await runtime.execute({
      workspaceId: "one",
      runId: "run-one",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      call: { id: "tool-art", name: "artifact_publish", arguments: {
        path: "reports/result.txt", mediaType: "text/plain",
      } },
    });
    expect(result).toMatchObject({ ok: true, metadata: { artifactId: "art_00000000000000000000000000000000" } });
    expect(published?.toString("utf8")).toBe("owned output");
    await expect(runtime.execute({
      workspaceId: "one", runId: "run-one",
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      call: { id: "tool-forged", name: "artifact_publish", arguments: {
        path: "reports/result.txt", mediaType: "text/plain", content: "forged bytes",
      } },
    })).rejects.toThrow(/authorized workspace path/);
  });
});
