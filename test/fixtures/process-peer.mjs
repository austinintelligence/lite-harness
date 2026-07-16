import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "rpc";
const lines = createInterface({ input: process.stdin });

if (mode === "process-partial") {
  process.stdout.write("x".repeat(8 * 1024));
  setInterval(() => {}, 1_000);
}

if (mode === "process-home") {
  process.stdout.write(`${JSON.stringify({ home: process.env.HOME, userProfile: process.env.USERPROFILE })}\n`);
  process.exit(0);
}

if (mode === "process-side-effect") {
  setTimeout(() => writeFileSync(process.argv[3], "late side effect"), 250);
  setInterval(() => {}, 1_000);
}

if (mode === "rpc-side-effect") {
  lines.once("line", () => {
    setTimeout(() => writeFileSync(process.argv[3], "late rpc side effect"), 250);
  });
  setInterval(() => {}, 1_000);
}

if (mode === "claude") {
  process.stdout.write(`${JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "delegated claude" } },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "result", result: "delegated claude", usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.01,
  })}\n`);
  process.exit(0);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
if (mode !== "rpc-side-effect") lines.on("line", (line) => {
  const message = JSON.parse(line);
  const response = (result) => send({ ...(message.jsonrpc ? { jsonrpc: "2.0" } : {}), id: message.id, result });
  const failure = (value) => send({ ...(message.jsonrpc ? { jsonrpc: "2.0" } : {}), id: message.id, error: { code: -32000, message: value } });

  if (message.method === "initialize") {
    if (mode === "plugin-initialize-error") failure("fixture initialize failed");
    else response(mode.startsWith("mcp")
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { platformFamily: "test" });
  } else if (message.method === "thread/start") {
    response({ thread: { id: "thread-fixture" } });
  } else if (message.method === "turn/start") {
    response({ turn: { id: "turn-fixture" } });
    queueMicrotask(() => {
      send({ method: "item/agentMessage/delta", params: { delta: "delegated codex" } });
      send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 3, outputTokens: 2 } } } });
      send({ method: "turn/completed", params: { turn: { id: "turn-fixture", status: "completed" } } });
    });
  } else if (message.method === "tools/list") {
    response(mode === "mcp-chaos"
      ? { tools: [{ name: "poison", inputSchema: { type: "not-a-json-schema-type" } }] }
      : { tools: [
          { name: "safe.echo", description: "echo", inputSchema: { type: "object" } },
          { name: "denied.tool", inputSchema: {} },
        ] });
  } else if (message.method === "tools/call") {
    if (mode === "mcp-chaos" && message.params.name === "server.pid") {
      response({ pid: process.pid });
    } else if (mode === "mcp-chaos" && message.params.name === "hang") {
      // Intentionally never answer; the client must time out and reap this process.
    } else if (mode === "mcp-chaos" && message.params.name === "crash") {
      process.exit(23);
    } else if (mode === "mcp-chaos" && message.params.name === "huge") {
      response({ content: "x".repeat(2048) });
    } else if (mode === "mcp-chaos" && message.params.name === "malformed") {
      process.stdout.write("{not-json}\n");
    } else {
      response({ content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] });
    }
  } else if (message.method === "health") {
    if (mode === "plugin-health-error") failure("fixture health failed");
    else response({ ok: true });
  } else if (message.method === "invoke") {
    response({ action: message.params.action, input: message.params.input });
  } else if (message.method === "migrate") {
    response({ migrated: true });
  } else if (message.method === "shutdown") {
    response({ ok: true });
    queueMicrotask(() => process.exit(0));
  } else if (message.id !== undefined) {
    response({});
  }
});
