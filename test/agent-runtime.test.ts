import { describe, expect, it, vi } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
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
