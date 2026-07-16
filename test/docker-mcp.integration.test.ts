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
