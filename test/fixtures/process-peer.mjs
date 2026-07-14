import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "rpc";
const lines = createInterface({ input: process.stdin });

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
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const response = (result) => send({ ...(message.jsonrpc ? { jsonrpc: "2.0" } : {}), id: message.id, result });

  if (message.method === "initialize") {
    response(mode === "mcp"
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
    response({ tools: [
      { name: "safe.echo", description: "echo", inputSchema: { type: "object" } },
      { name: "denied.tool", inputSchema: {} },
    ] });
  } else if (message.method === "tools/call") {
    response({ content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] });
  } else if (message.method === "health") {
    response({ ok: true });
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
