import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BrokeredMcpToolPolicy,
  DockerStdioMcpTransport,
  McpSupervisor,
  StdioMcpTransport,
  createDockerMcpProcessSpec,
} from "@lite-harness/mcp";

const processFixture = fileURLToPath(new URL("./fixtures/process-peer.mjs", import.meta.url));

describe("brokered MCP isolation BD-045-REGRESSION", () => {
  it("A08-MCP-ORPHAN-OWNERSHIP scopes stdio MCP containers to the Manager installation for restart reconciliation", () => {
    const installationId = "C:\\lite-harness\\a08-installation";
    const spec = createDockerMcpProcessSpec({
      image: `sha256:${"a".repeat(64)}`,
      command: "node",
      installationId,
    });
    const digest = createHash("sha256").update(installationId).digest("hex").slice(0, 32);
    expect(spec.args).toContain("lite-harness.installation=" + digest);
  });

  it("A21-STDIO-SANDBOX builds stdio MCP only as a disposable hardened no-network Docker process", () => {
    const spec = createDockerMcpProcessSpec({
      image: `sha256:${"a".repeat(64)}`,
      command: "node",
      args: ["/app/server.mjs"],
      seccompProfile: "/policy/seccomp.json",
      containerName: "lite-harness-mcp-spec",
    });
    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual(expect.arrayContaining([
      "--pull=never", "--init", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--name", "lite-harness-mcp-spec", "--label", "lite-harness.managed=true", "--label", "lite-harness.component=mcp",
      "--security-opt", "seccomp=/policy/seccomp.json", "--user", "1000:1000",
      "--pids-limit", "64", "--memory", "256m", "--cpus", "1",
    ]));
    expect(spec.args).not.toContain("--env");
    expect(spec.args).not.toContain("--volume");
    expect(spec.args).not.toContain("--rm");
    expect(() => createDockerMcpProcessSpec({ image: "mcp:latest", command: "node" })).toThrow(/pinned/);
    expect(() => createDockerMcpProcessSpec({
      image: `sha256:${"a".repeat(64)}`, command: "node", containerName: "unmanaged",
    })).toThrow(/container name/);
  });

  it("A21-STDIO-CONTAINER-REAP independently kills, waits for, removes, and verifies the named MCP container", async () => {
    const commands: string[][] = [];
    let exists = true;
    let running = true;
    const cleanupRunner = vi.fn(async (args: readonly string[]) => {
      commands.push([...args]);
      if (args[0] === "container" && args[1] === "inspect") {
        return exists
          ? { code: 0, stdout: args.includes("--format") ? `${running}|${running ? "running" : "exited"}` : "{}", stderr: "" }
          : { code: 1, stdout: "", stderr: "Error: No such container" };
      }
      if (args[0] === "container" && args[1] === "kill") { running = false; return { code: 0, stdout: "id", stderr: "" }; }
      if (args[0] === "container" && args[1] === "wait") return { code: 0, stdout: "137", stderr: "" };
      if (args[0] === "container" && args[1] === "rm") { exists = false; return { code: 0, stdout: "id", stderr: "" }; }
      throw new Error(`Unexpected cleanup command: ${args.join(" ")}`);
    });
    const transport = new DockerStdioMcpTransport({
      image: `sha256:${"a".repeat(64)}`, command: "node", containerName: "lite-harness-mcp-reap",
      cleanupRunner,
    });

    await transport.stop();
    expect(commands.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "container inspect", "container kill", "container wait", "container rm", "container inspect",
    ]);
    expect(exists).toBe(false);
  });

  it("A21-POLICY-GRANTS applies one bounded include/exclude and JSON policy before transport", () => {
    const policy = new BrokeredMcpToolPolicy({
      include: ["read_*"], exclude: ["read_secret"], maxPayloadBytes: 128, compileSchemas: true,
    });
    expect(() => policy.assertCall("write_file", {})).toThrow(/denied/);
    expect(() => policy.assertCall("read_secret", {})).toThrow(/denied/);
    expect(() => policy.assertCall("read_file", { text: "x".repeat(256) })).toThrow(/payload/);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => policy.assertCall("read_file", circular)).toThrow(/JSON serializable/);
    expect(policy.filterTools([
      { name: "read_file", inputSchema: { type: "object", properties: { email: { type: "string", format: "email" } } } },
      { name: "write_file", inputSchema: { type: "object" } },
    ])).toMatchObject([{ name: "read_file" }]);
  });

  it("A21-SCHEMA-COMPLEXITY-BOUND rejects a valid-depth bomb without compiling hostile schema or delaying a healthy sibling", async () => {
    const supervisor = new McpSupervisor({ timeoutMs: 1_000, maxPayloadBytes: 1024 * 1024, idleTtlMs: 0 });
    const healthyStop = vi.fn(async () => undefined);
    supervisor.register("complexity-healthy", () => ({
      start: async () => undefined,
      call: async () => ({ ok: true }),
      stop: healthyStop,
    }));
    let schema: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 40; index += 1) {
      schema = { type: "object", properties: { child: schema } };
    }
    const bombStop = vi.fn(async () => undefined);
    supervisor.register("complexity-bomb", () => ({
      start: async () => undefined,
      call: async () => ({}),
      listTools: async () => [{ name: "bomb", inputSchema: schema }],
      stop: bombStop,
    }));

    const rejected = expect(supervisor.listTools("complexity-bomb")).rejects.toThrow(/structural complexity limits/);
    await expect(supervisor.call("complexity-healthy", "read", {})).resolves.toEqual({ ok: true });
    await rejected;
    expect(bombStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("complexity-bomb")).toBe(false);
    expect(supervisor.isActive("complexity-healthy")).toBe(true);
    await supervisor.stopAll();
    expect(healthyStop).toHaveBeenCalledOnce();
  });

  it("A21-SCHEMA-SEMANTIC-VALIDATION rejects semantically invalid schemas from an unpinned dynamic catalog", async () => {
    const policy = new BrokeredMcpToolPolicy();
    expect(() => policy.filterTools([
      { name: "invalid-array", inputSchema: { type: "array", minItems: -1 } },
    ])).toThrow(/valid JSON Schema/);

    const supervisor = new McpSupervisor({ timeoutMs: 1_000, idleTtlMs: 0 });
    const invalidStop = vi.fn(async () => undefined);
    supervisor.register("semantic-invalid", () => ({
      start: async () => undefined,
      call: async () => ({}),
      listTools: async () => [{ name: "invalid-pattern", inputSchema: { type: "string", pattern: 7 } }],
      stop: invalidStop,
    }));
    const healthyStop = vi.fn(async () => undefined);
    supervisor.register("semantic-healthy", () => ({
      start: async () => undefined,
      call: async () => ({ ok: true }),
      stop: healthyStop,
    }));

    await expect(supervisor.listTools("semantic-invalid")).rejects.toThrow(/valid JSON Schema/);
    expect(invalidStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("semantic-invalid")).toBe(false);
    await expect(supervisor.call("semantic-healthy", "read", {})).resolves.toEqual({ ok: true });
    await supervisor.stopAll();
    expect(healthyStop).toHaveBeenCalledOnce();
  });

  it("A21-FAILURE-ISOLATION stops hang, crash, huge output, malicious schema, and malformed output without affecting a healthy sibling", async () => {
    const supervisor = new McpSupervisor({ timeoutMs: 25, maxPayloadBytes: 1024, idleTtlMs: 0 });
    const healthyStop = vi.fn(async () => undefined);
    supervisor.register("healthy", () => ({
      start: async () => undefined,
      call: async (_tool, input) => ({ ok: true, input }),
      stop: healthyStop,
    }));
    await expect(supervisor.call("healthy", "read", { value: 1 })).resolves.toEqual({ ok: true, input: { value: 1 } });
    expect(supervisor.isActive("healthy")).toBe(true);

    const hungStop = vi.fn(async () => undefined);
    supervisor.register("hung", () => ({
      start: async () => undefined,
      call: async () => await new Promise<never>(() => undefined),
      stop: hungStop,
    }));
    await expect(supervisor.call("hung", "read", {})).rejects.toThrow(/timed out/);
    expect(hungStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("hung")).toBe(false);

    const crashStop = vi.fn(async () => undefined);
    const crashFactory = vi.fn(() => ({
      start: async () => undefined,
      call: async () => { throw new Error("server crashed"); },
      stop: crashStop,
    }));
    supervisor.register("crash", crashFactory);
    await expect(supervisor.call("crash", "read", {})).rejects.toThrow(/server crashed/);
    await expect(supervisor.call("crash", "read", {})).rejects.toThrow(/crash backoff/);
    expect(crashFactory).toHaveBeenCalledOnce();
    expect(crashStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("crash")).toBe(false);

    const hugeStop = vi.fn(async () => undefined);
    supervisor.register("huge", () => ({
      start: async () => undefined,
      call: async () => ({ content: "x".repeat(2048) }),
      stop: hugeStop,
    }));
    await expect(supervisor.call("huge", "read", {})).rejects.toThrow(/output exceeds the payload limit/);
    expect(hugeStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("huge")).toBe(false);

    const schemaStop = vi.fn(async () => undefined);
    supervisor.register("schema", () => ({
      start: async () => undefined,
      call: async () => ({}),
      listTools: async () => [{ name: "poison", inputSchema: { type: "not-a-json-schema-type" } }],
      stop: schemaStop,
    }));
    await expect(supervisor.listTools("schema")).rejects.toThrow(/valid JSON Schema/);
    expect(schemaStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("schema")).toBe(false);

    const malformedOutput: Record<string, unknown> = {};
    malformedOutput.self = malformedOutput;
    const malformedStop = vi.fn(async () => undefined);
    supervisor.register("malformed", () => ({
      start: async () => undefined,
      call: async () => malformedOutput,
      stop: malformedStop,
    }));
    await expect(supervisor.call("malformed", "read", {})).rejects.toThrow(/not JSON serializable/);
    expect(malformedStop).toHaveBeenCalledOnce();
    expect(supervisor.isActive("malformed")).toBe(false);

    await expect(supervisor.call("healthy", "read", { value: 2 })).resolves.toEqual({ ok: true, input: { value: 2 } });
    expect(healthyStop).not.toHaveBeenCalled();
    await supervisor.stopAll();
    expect(healthyStop).toHaveBeenCalledOnce();
  });

  it("A21-REAL-PROCESS-ISOLATION reaps real hung, crashed, oversized, malicious-schema, and malformed stdio peers while a sibling stays live", async () => {
    const supervisor = new McpSupervisor({ timeoutMs: 2_000, maxPayloadBytes: 1024, idleTtlMs: 0 });
    const pids: number[] = [];
    const startPeer = async (id: string): Promise<number> => {
      supervisor.register(id, () => new StdioMcpTransport({
        command: process.execPath, args: [processFixture, "mcp-chaos"],
      }, { timeoutMs: 5_000, maxPayloadBytes: 4096 }));
      const result = await supervisor.call(id, "server.pid", {}) as { pid: number };
      pids.push(result.pid);
      expect(isProcessAlive(result.pid)).toBe(true);
      return result.pid;
    };

    const healthyPid = await startPeer("real-healthy");
    try {
      const hungPid = await startPeer("real-hung");
      const controller = new AbortController();
      const hung = supervisor.call("real-hung", "hang", {}, controller.signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(new Error("cancel real hung MCP peer"));
      await expect(hung).rejects.toThrow(/cancel real hung MCP peer/);
      expect(supervisor.isActive("real-hung")).toBe(false);
      expect(isProcessAlive(hungPid)).toBe(false);

      const crashPid = await startPeer("real-crash");
      await expect(supervisor.call("real-crash", "crash", {})).rejects.toThrow(/process exited/i);
      expect(supervisor.isActive("real-crash")).toBe(false);
      expect(isProcessAlive(crashPid)).toBe(false);

      const hugePid = await startPeer("real-huge");
      await expect(supervisor.call("real-huge", "huge", {})).rejects.toThrow(/output exceeds the payload limit/);
      expect(supervisor.isActive("real-huge")).toBe(false);
      expect(isProcessAlive(hugePid)).toBe(false);

      const schemaPid = await startPeer("real-schema");
      await expect(supervisor.listTools("real-schema")).rejects.toThrow(/valid JSON Schema/);
      expect(supervisor.isActive("real-schema")).toBe(false);
      expect(isProcessAlive(schemaPid)).toBe(false);

      const malformedPid = await startPeer("real-malformed");
      await expect(supervisor.call("real-malformed", "malformed", {})).rejects.toThrow(/invalid JSON/i);
      expect(supervisor.isActive("real-malformed")).toBe(false);
      expect(isProcessAlive(malformedPid)).toBe(false);

      await expect(supervisor.call("real-healthy", "server.pid", {})).resolves.toEqual({ pid: healthyPid });
      expect(isProcessAlive(healthyPid)).toBe(true);
    } finally {
      await supervisor.stopAll();
    }
    expect(supervisor.isActive("real-healthy")).toBe(false);
    for (const pid of pids) expect(isProcessAlive(pid)).toBe(false);
  });
});

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
