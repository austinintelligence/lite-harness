import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DockerStdioMcpTransport, McpSupervisor } from "@lite-harness/mcp";

const image = requiredImage("LITE_HARNESS_TEST_MCP_IMAGE");

const SERVER = String.raw`
const {createInterface}=require('node:readline');
const input=createInterface({input:process.stdin});
input.on('line',(line)=>{
  const request=JSON.parse(line);
  if(request.id===undefined)return;
  let result={};
  if(request.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}}};
  if(request.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};
  if(request.method==='tools/call')result={content:[{type:'text',text:String(request.params.arguments.text)}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
`;

const CHAOS_SERVER = String.raw`
const {createInterface}=require('node:readline');
const input=createInterface({input:process.stdin});
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
input.on('line',(line)=>{
  const request=JSON.parse(line);
  if(request.id===undefined)return;
  if(request.method==='initialize')return send(request.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}}});
  if(request.method==='tools/list')return send(request.id,{tools:[{name:'poison',inputSchema:{type:'not-a-json-schema-type'}}]});
  if(request.method!=='tools/call')return send(request.id,{});
  const name=request.params.name;
  if(name==='hang')return;
  if(name==='crash')process.exit(23);
  if(name==='huge')return send(request.id,{content:'x'.repeat(2048)});
  if(name==='malformed')return process.stdout.write('{not-json}\n');
  return send(request.id,{content:[{type:'text',text:'healthy'}]});
});
`;

describe("Docker stdio MCP integration", () => {
  it("A05-MCP-CONTAINER-SECRET-SENTINELS keeps app, provider, integration, root, and IPC sentinels out of the live MCP container", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const containerName = `lite-harness-mcp-a05-${suffix}`;
    const installationId = `a05-mcp-installation-${suffix}`;
    const sentinels = [
      `A05_MCP_APP_${suffix}`,
      `A05_MCP_PROVIDER_${suffix}`,
      `A05_MCP_INTEGRATION_${suffix}`,
      `A05_MCP_ROOT_${suffix}`,
      `A05_MCP_IPC_${suffix}`,
    ];
    const env = {
      LITE_A05_MCP_APP_SENTINEL: sentinels[0]!,
      LITE_A05_MCP_PROVIDER_SENTINEL: sentinels[1]!,
      LITE_A05_MCP_INTEGRATION_SENTINEL: sentinels[2]!,
      LITE_A05_MCP_ROOT_SENTINEL: sentinels[3]!,
      LITE_A05_MCP_IPC_SENTINEL: sentinels[4]!,
    };
    const previous = new Map<string, string | undefined>();
    const transport = new DockerStdioMcpTransport({
      image, command: "node", args: ["-e", SERVER], containerName, installationId, timeoutMs: 30_000,
    });
    try {
      for (const [name, value] of Object.entries(env)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }
      await expect(transport.listTools()).resolves.toMatchObject([{ name: "echo" }]);
      await waitFor(() => containerExists(containerName), 15_000);
      assertNoSentinels(dockerText(["container", "inspect", containerName]), sentinels);
      assertNoSentinels(dockerText(["container", "logs", containerName]), sentinels);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await transport.stop();
      expect(containerExists(containerName)).toBe(false);
    }
  }, 90_000);

  it("executes the MCP protocol in a no-network immutable container", async () => {
    const transport = new DockerStdioMcpTransport({
      image,
      command: "node",
      args: ["-e", SERVER],
      timeoutMs: 30_000,
    });
    try {
      await expect(transport.listTools()).resolves.toMatchObject([{ name: "echo" }]);
      await expect(transport.call("echo", { text: "isolated" })).resolves.toMatchObject({
        content: [{ type: "text", text: "isolated" }],
      });
    } finally {
      await transport.stop();
    }
  }, 60_000);

  it("A07-REAL-MCP-HARDENING-INSPECT applies the bounded no-network policy to the live MCP container", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const containerName = `lite-harness-mcp-a07-${suffix}`;
    const installationId = `a07-mcp-installation-${suffix}`;
    const transport = new DockerStdioMcpTransport({
      image, command: "node", args: ["-e", SERVER], containerName, installationId,
      memory: "32m", cpus: "0.5", pidsLimit: 32, timeoutMs: 30_000,
    });
    try {
      await expect(transport.listTools()).resolves.toMatchObject([{ name: "echo" }]);
      await waitFor(() => containerExists(containerName), 15_000);
      const inspected = dockerInspect(containerName);
      expect(inspected.Config.User).toBe("1000:1000");
      expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspected.HostConfig.NetworkMode).toBe("none");
      expect(inspected.HostConfig.CapDrop).toEqual(expect.arrayContaining(["ALL"]));
      expect(inspected.HostConfig.SecurityOpt.some((option) => /^no-new-privileges(?:=true)?$/.test(option))).toBe(true);
      expect(inspected.HostConfig.SecurityOpt).not.toContain("seccomp=default");
      expect(inspected.HostConfig.Memory).toBe(32 * 1024 * 1024);
      expect(inspected.HostConfig.NanoCpus).toBe(500_000_000);
      expect(inspected.HostConfig.PidsLimit).toBe(32);
      expect(inspected.HostConfig.Tmpfs["/tmp"]).toMatch(/noexec/);
    } finally {
      await transport.stop();
      expect(containerExists(containerName)).toBe(false);
    }
  }, 90_000);

  it("A22-REAL-MCP-IDLE-ZERO reaps the real MCP container after its final idle interval", async () => {
    const containerName = `lite-harness-mcp-${randomUUID().replaceAll("-", "")}`;
    const supervisor = new McpSupervisor({ timeoutMs: 30_000, idleTtlMs: 75 });
    supervisor.register("idle-real", () => new DockerStdioMcpTransport({
      image, command: "node", args: ["-e", SERVER], containerName, timeoutMs: 30_000,
    }));
    try {
      await expect(supervisor.call("idle-real", "echo", { text: "scale-zero" })).resolves.toMatchObject({
        content: [{ text: "scale-zero" }],
      });
      expect(containerExists(containerName)).toBe(true);
      await waitFor(() => !supervisor.isActive("idle-real") && !containerExists(containerName), 10_000);
      expect(supervisor.isActive("idle-real")).toBe(false);
      expect(containerExists(containerName)).toBe(false);
    } finally {
      await supervisor.stopAll();
    }
  }, 60_000);

  it("A21-REAL-CONTAINER-CHAOS reaps Docker MCP hang, crash, huge, malicious-schema, and malformed peers while a sibling stays live", async () => {
    const supervisor = new McpSupervisor({ timeoutMs: 30_000, maxPayloadBytes: 1024, idleTtlMs: 0 });
    const names: string[] = [];
    const register = (id: string): string => {
      const containerName = `lite-harness-mcp-${randomUUID().replaceAll("-", "")}`;
      names.push(containerName);
      supervisor.register(id, () => new DockerStdioMcpTransport({
        image, command: "node", args: ["-e", CHAOS_SERVER], containerName,
        timeoutMs: 30_000, maxPayloadBytes: 4096,
      }));
      return containerName;
    };
    const healthyName = register("docker-healthy");
    try {
      await expect(supervisor.call("docker-healthy", "echo", {})).resolves.toMatchObject({ content: [{ text: "healthy" }] });
      expect(containerExists(healthyName)).toBe(true);

      const hungName = register("docker-hung");
      await supervisor.call("docker-hung", "echo", {});
      const controller = new AbortController();
      const hung = expect(supervisor.call("docker-hung", "hang", {}, controller.signal)).rejects.toThrow(/cancel Docker MCP hang/);
      await new Promise((resolve) => setTimeout(resolve, 250));
      controller.abort(new Error("cancel Docker MCP hang"));
      await hung;
      expect(supervisor.isActive("docker-hung")).toBe(false);
      expect(containerExists(hungName)).toBe(false);

      const crashName = register("docker-crash");
      await supervisor.call("docker-crash", "echo", {});
      await expect(supervisor.call("docker-crash", "crash", {})).rejects.toThrow(/process exited/i);
      expect(supervisor.isActive("docker-crash")).toBe(false);
      expect(containerExists(crashName)).toBe(false);

      const hugeName = register("docker-huge");
      await supervisor.call("docker-huge", "echo", {});
      await expect(supervisor.call("docker-huge", "huge", {})).rejects.toThrow(/output exceeds the payload limit/);
      expect(supervisor.isActive("docker-huge")).toBe(false);
      expect(containerExists(hugeName)).toBe(false);

      const schemaName = register("docker-schema");
      await supervisor.call("docker-schema", "echo", {});
      await expect(supervisor.listTools("docker-schema")).rejects.toThrow(/valid JSON Schema/);
      expect(supervisor.isActive("docker-schema")).toBe(false);
      expect(containerExists(schemaName)).toBe(false);

      const malformedName = register("docker-malformed");
      await supervisor.call("docker-malformed", "echo", {});
      await expect(supervisor.call("docker-malformed", "malformed", {})).rejects.toThrow(/invalid JSON/i);
      expect(supervisor.isActive("docker-malformed")).toBe(false);
      expect(containerExists(malformedName)).toBe(false);

      await expect(supervisor.call("docker-healthy", "echo", {})).resolves.toMatchObject({ content: [{ text: "healthy" }] });
      expect(containerExists(healthyName)).toBe(true);
    } finally {
      await supervisor.stopAll();
    }
    for (const name of names) expect(containerExists(name)).toBe(false);
  }, 120_000);
});

function requiredImage(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run this suite through pnpm test:real-runtime`);
  return value;
}

function containerExists(name: string): boolean {
  return spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" }).status === 0;
}

function dockerText(args: readonly string[]): string {
  const result = spawnSync("docker", [...args], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker command failed: ${result.stderr || result.stdout}`);
  return result.stdout ?? "";
}

function dockerInspect(name: string): {
  Config: { User: string };
  HostConfig: {
    ReadonlyRootfs: boolean; NetworkMode: string; CapDrop: string[]; SecurityOpt: string[];
    Memory: number; NanoCpus: number; PidsLimit: number; Tmpfs: Record<string, string>;
  };
} {
  const parsed = JSON.parse(dockerText(["container", "inspect", name])) as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object") throw new Error("A07 MCP Docker inspect output was invalid");
  return parsed[0] as ReturnType<typeof dockerInspect>;
}

function assertNoSentinels(value: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) expect(value).not.toContain(sentinel);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Docker MCP scale-to-zero cleanup");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
