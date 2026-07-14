import { describe, expect, it, vi } from "vitest";
import { StreamableHttpMcpTransport } from "@lite-harness/mcp";

describe("brokered Streamable HTTP MCP", () => {
  it("negotiates a session, bounds credentials to one origin, and terminates cleanly", async () => {
    const calls: Array<{ method: string; headers: Headers; body?: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ method: init?.method ?? "GET", headers, ...(body ? { body } : {}) });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body?.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }, {
        headers: { "mcp-session-id": "session-1" },
      });
      if (body?.method === "tools/list") return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: {} }] } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
      return Response.json({ jsonrpc: "2.0", id: body?.id, result: { content: [{ type: "text", text: "ok" }] } });
    });
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc", allowedOrigins: ["https://mcp.example.test"],
      authorization: async () => "Bearer mcp-secret", fetch,
    });
    await expect(transport.listTools()).resolves.toMatchObject([{ name: "echo" }]);
    await expect(transport.call("echo", { value: 1 })).resolves.toMatchObject({ content: [{ text: "ok" }] });
    await transport.stop();
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer mcp-secret")).toBe(true);
    expect(calls.slice(1).every((call) => call.headers.get("mcp-session-id") === "session-1")).toBe(true);
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("rejects mutable origins, credential URLs, and remote plain HTTP", () => {
    expect(() => new StreamableHttpMcpTransport({ url: "https://other.test/rpc", allowedOrigins: ["https://mcp.test"] })).toThrow(/allowlisted/);
    expect(() => new StreamableHttpMcpTransport({ url: "https://user:pass@mcp.test/rpc", allowedOrigins: ["https://mcp.test"] })).toThrow(/credentials/);
    expect(() => new StreamableHttpMcpTransport({ url: "http://mcp.test/rpc", allowedOrigins: ["http://mcp.test"] })).toThrow(/requires HTTPS/);
  });
});
