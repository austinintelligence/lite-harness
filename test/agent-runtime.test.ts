import { describe, expect, it, vi } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { ArtifactPublishingRuntime, InMemoryToolRuntime } from "@lite-harness/runtime";
import type { ToolRuntime } from "@lite-harness/runtime";
import type { ModelEvent, ModelGateway } from "@lite-harness/provider-core";

describe("AgentRunner", () => {
  it("streams a model turn, executes a tool, and completes a follow-up turn", async () => {
    const runtime = new InMemoryToolRuntime();
    const onEvent = vi.fn();
    const runner = new AgentRunner(new FakeModelGateway(), runtime);

    await runner.run({
      input: "make the demo file",
      allowedTools: ["write_file"],
      workspaceId: "workspace-1",
      onEvent,
    });

    expect(runtime.readFile("workspace-1", "hello.txt")).toContain("make the demo file");
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "agent.message.delta",
      "usage.updated",
      "agent.message.completed",
      "tool.call.requested",
      "tool.call.completed",
      "agent.message.delta",
      "usage.updated",
      "agent.message.completed",
    ]);
  });

  it.each([99, 3_600_001, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid direct command timeout (%s) before executing the tool",
    async (commandTimeoutMs) => {
      const runtime = new InMemoryToolRuntime();
      const execute = vi.spyOn(runtime, "execute");

      await expect(new AgentRunner(new FakeModelGateway(), runtime).run({
        input: "make the demo file",
        allowedTools: ["write_file"],
        workspaceId: "invalid-command-timeout",
        commandTimeoutMs,
        onEvent: () => undefined,
      })).rejects.toThrow(new RangeError("Command timeout must be between 100 and 3600000 milliseconds"));
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("advertises only profile-approved tools and prepends agent instructions", async () => {
    const observed: Array<{ roles: string[]; tools: string[] }> = [];
    let compiledAllowedTools: readonly string[] | undefined;
    const model: ModelGateway = {
      async *streamTurn(params): AsyncIterable<ModelEvent> {
        observed.push({ roles: params.messages.map((message) => message.role), tools: (params.tools ?? []).map((tool) => tool.name) });
        yield { type: "text.delta", delta: "done" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    await new AgentRunner(model, new InMemoryToolRuntime(), 8, {
      compile: async (params) => { compiledAllowedTools = params.allowedTools; return []; },
    }).run({
      input: "inspect", instructions: "Be precise.", allowedTools: ["read_file"], workspaceId: "workspace-2", onEvent: () => undefined,
    });
    expect(observed).toEqual([{ roles: ["system", "user"], tools: ["read_file"] }]);
    expect(compiledAllowedTools).toEqual(["read_file"]);
  });

  it("rejects an over-limit selected route before model streaming and carries its context window to compilation", async () => {
    let streamCalls = 0;
    let compiledContextWindow: number | undefined;
    const model: ModelGateway = {
      prepareRun: async () => ({
        routePlanId: "route-small", modelId: "small-model", providerId: "fixture",
        capabilities: ["text"], contextWindow: 16,
      }),
      async *streamTurn() {
        streamCalls += 1;
        yield { type: "completed", finishReason: "stop" };
      },
    };
    await expect(new AgentRunner(model, new InMemoryToolRuntime(), 1, {
      compile: async (params) => { compiledContextWindow = params.modelContextWindow; return []; },
    }).run({
      input: "x".repeat(256), workspaceId: "context-limit", runId: "run-context-limit",
      attemptId: "attempt-context-limit", fencingToken: 1,
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      onEvent: () => undefined,
    })).rejects.toMatchObject({ code: "context_limit_exceeded" });
    expect(compiledContextWindow).toBe(16);
    expect(streamCalls).toBe(0);
  });

  it("BD-035-REGRESSION exposes a fenced agent-created artifact ID through the durable event stream", async () => {
    const workspace = new InMemoryToolRuntime();
    let fenceChecks = 0;
    const runtime = new ArtifactPublishingRuntime(workspace, {
      publish: (params) => ({
        id: "art_00000000000000000000000000000000",
        runId: params.runId,
        appId: params.principal.appId,
        tenantId: params.principal.tenantId,
        userId: params.principal.userId,
        workspaceId: params.workspaceId,
        path: params.path,
        mediaType: params.mediaType,
        sizeBytes: params.data.length,
        sha256: "a".repeat(64),
        createdAt: new Date().toISOString(),
      }),
    }, undefined, (params) => {
      fenceChecks += 1;
      return params.runId === "run-artifact" && params.attemptId === "attempt-artifact" && params.fencingToken === 1;
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    await new AgentRunner(new FakeModelGateway(), runtime).run({
      input: "create and publish the fixture",
      allowedTools: ["write_file", "artifact_publish"],
      workspaceId: "artifact-workspace",
      runId: "run-artifact",
      attemptId: "attempt-artifact",
      fencingToken: 1,
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      onEvent: (event) => events.push(event),
    });

    expect(events.find((event) => event.type === "artifact.created")).toEqual({
      type: "artifact.created",
      payload: {
        artifactId: "art_00000000000000000000000000000000",
        path: "hello.txt",
        sha256: "a".repeat(64),
        sizeBytes: expect.any(Number),
      },
    });
    expect(fenceChecks).toBe(2);
    const eventTypes = events.map(({ type }) => type);
    expect(eventTypes[eventTypes.indexOf("artifact.created") - 1]).toBe("tool.call.completed");
  });

  it("BD-035-REGRESSION ignores artifact metadata spoofed by a non-artifact tool", async () => {
    const definitions = new InMemoryToolRuntime().listTools();
    const runtime: ToolRuntime = {
      listTools: () => definitions,
      execute: async ({ call }) => ({
        callId: call.id,
        ok: true,
        content: "spoofed metadata",
        metadata: {
          artifactId: "art_00000000000000000000000000000000",
          path: "hello.txt",
          sha256: "a".repeat(64),
          sizeBytes: 1,
        },
      }),
    };
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    await new AgentRunner(new FakeModelGateway(), runtime).run({
      input: "attempt to spoof an artifact",
      allowedTools: ["write_file"],
      workspaceId: "spoof-workspace",
      onEvent: (event) => events.push(event),
    });

    expect(events.some(({ type }) => type === "artifact.created")).toBe(false);
  });

  it("BD-035-REGRESSION rejects malformed artifact publication metadata without emitting an event", async () => {
    const workspace = new InMemoryToolRuntime();
    const runtime = new ArtifactPublishingRuntime(workspace, {
      publish: (params) => ({
        id: "art_invalid",
        runId: params.runId,
        appId: params.principal.appId,
        tenantId: params.principal.tenantId,
        userId: params.principal.userId,
        workspaceId: params.workspaceId,
        path: params.path,
        mediaType: params.mediaType,
        sizeBytes: params.data.length,
        sha256: "a".repeat(64),
        createdAt: new Date().toISOString(),
      }),
    }, undefined, () => true);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    await expect(new AgentRunner(new FakeModelGateway(), runtime).run({
      input: "publish malformed metadata",
      allowedTools: ["write_file", "artifact_publish"],
      workspaceId: "invalid-artifact-workspace",
      runId: "run-invalid-artifact",
      attemptId: "attempt-invalid-artifact",
      fencingToken: 1,
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      onEvent: (event) => events.push(event),
    })).rejects.toThrow(/invalid artifact metadata/);
    expect(events.some(({ type }) => type === "artifact.created")).toBe(false);
  });

  it("BD-035-REGRESSION suppresses publication and artifact events after losing the workspace fence", async () => {
    const workspace = new InMemoryToolRuntime();
    let active = true;
    let published = false;
    const inner: ToolRuntime = {
      listTools: () => workspace.listTools(),
      execute: async (params) => await workspace.execute(params),
      readWorkspaceArtifact: async (params) => {
        const data = await workspace.readWorkspaceArtifact(params);
        active = false;
        return data;
      },
    };
    const runtime = new ArtifactPublishingRuntime(inner, {
      publish: (params) => {
        published = true;
        return {
          id: "art_00000000000000000000000000000001",
          runId: params.runId,
          appId: params.principal.appId,
          tenantId: params.principal.tenantId,
          userId: params.principal.userId,
          workspaceId: params.workspaceId,
          path: params.path,
          mediaType: params.mediaType,
          sizeBytes: params.data.length,
          sha256: "b".repeat(64),
          createdAt: new Date().toISOString(),
        };
      },
    }, undefined, (params) => active && params.fencingToken === 1);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    await expect(new AgentRunner(new FakeModelGateway(), runtime).run({
      input: "lose the fence while publishing",
      allowedTools: ["write_file", "artifact_publish"],
      workspaceId: "lost-fence-workspace",
      runId: "run-lost-fence",
      attemptId: "attempt-lost-fence",
      fencingToken: 1,
      principal: { appId: "app", tenantId: "tenant", userId: "user", scopes: [] },
      onEvent: (event) => events.push(event),
    })).rejects.toThrow(/fence changed/i);
    expect(published).toBe(false);
    expect(events.some(({ type }) => type === "artifact.created")).toBe(false);
  });

  it("BD-003-REGRESSION does not let non-cooperative iterator cleanup defeat the model deadline", async () => {
    const never = new Promise<never>(() => undefined);
    let cleanupStarted = false;
    const model: ModelGateway = {
      streamTurn() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => never,
              return: () => {
                cleanupStarted = true;
                return never;
              },
            };
          },
        };
      },
    };
    const run = new AgentRunner(model, new InMemoryToolRuntime()).run({
      input: "hang",
      workspaceId: "workspace-deadline",
      modelIdleTimeoutMs: 10,
      onEvent: () => undefined,
    });

    await expect(Promise.race([
      run.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
    ])).resolves.toBe("rejected");
    expect(cleanupStarted).toBe(true);
  });
});
