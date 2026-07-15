import { describe, expect, it, vi } from "vitest";
import {
  BrokeredMcpToolPolicy,
  McpSupervisor,
  createDockerMcpProcessSpec,
  type McpTransport,
} from "@lite-harness/mcp";

describe("brokered MCP isolation", () => {
  it("builds stdio MCP only as a hardened no-network Docker process", () => {
    const spec = createDockerMcpProcessSpec({
      image: `sha256:${"a".repeat(64)}`,
      command: "node",
      args: ["/app/server.mjs"],
      seccompProfile: "/policy/seccomp.json",
    });
    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual(expect.arrayContaining([
      "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--security-opt", "seccomp=/policy/seccomp.json", "--user", "1000:1000",
    ]));
    expect(spec.args).not.toContain("--env");
    expect(spec.args).not.toContain("--volume");
    expect(() => createDockerMcpProcessSpec({ image: "mcp:latest", command: "node" })).toThrow(/pinned/);
  });

  it("applies one bounded include/exclude and JSON policy before transport", () => {
    const policy = new BrokeredMcpToolPolicy({ include: ["read_*"], exclude: ["read_secret"], maxPayloadBytes: 128 });
    expect(() => policy.assertCall("write_file", {})).toThrow(/denied/);
    expect(() => policy.assertCall("read_secret", {})).toThrow(/denied/);
    expect(() => policy.assertCall("read_file", { text: "x".repeat(256) })).toThrow(/payload/);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => policy.assertCall("read_file", circular)).toThrow(/JSON serializable/);
    expect(policy.filterTools([
      { name: "read_file", inputSchema: { type: "object" } },
      { name: "write_file", inputSchema: { type: "object" } },
    ])).toMatchObject([{ name: "read_file" }]);
  });

  it("cancels a non-cooperative server and isolates malformed tool schemas", async () => {
    const stop = vi.fn(async () => undefined);
    const supervisor = new McpSupervisor({ timeoutMs: 5_000, maxPayloadBytes: 1024 });
    supervisor.register("hung", () => ({
      start: async () => undefined,
      call: async () => await new Promise<never>(() => undefined),
      stop,
    }));
    const controller = new AbortController();
    const pending = supervisor.call("hung", "read", {}, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(stop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("hung")).toBe(false);

    const malformedStop = vi.fn(async () => undefined);
    const malformed: McpTransport = {
      start: async () => undefined,
      call: async () => ({}),
      listTools: async () => [{ name: "bad", inputSchema: "not-a-schema" }],
      stop: malformedStop,
    };
    supervisor.register("malformed", () => malformed);
    await expect(supervisor.listTools("malformed")).rejects.toThrow(/input schema/);
    expect(malformedStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("malformed")).toBe(false);
  });
});
