import { describe, expect, it, vi } from "vitest";
import { AgentRunner, FakeModelGateway } from "@lite-harness/agent-runtime";
import { InMemoryToolRuntime } from "@lite-harness/runtime";

describe("AgentRunner", () => {
  it("streams a model turn, executes a tool, and completes a follow-up turn", async () => {
    const runtime = new InMemoryToolRuntime();
    const onEvent = vi.fn();
    const runner = new AgentRunner(new FakeModelGateway(), runtime);

    await runner.run({
      input: "make the demo file",
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
});
