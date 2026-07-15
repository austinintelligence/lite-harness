import { describe, expect, it } from "vitest";
import { DockerStdioMcpTransport } from "@lite-harness/mcp";

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

describe("Docker stdio MCP integration", () => {
  it.skipIf(!process.env.LITE_HARNESS_TEST_MCP_IMAGE)("executes the MCP protocol in a no-network immutable container", async () => {
    const transport = new DockerStdioMcpTransport({
      image: process.env.LITE_HARNESS_TEST_MCP_IMAGE as string,
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
});
