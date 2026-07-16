import { describe, expect, it, vi } from "vitest";
import { McpSupervisor, StreamableHttpMcpTransport } from "@lite-harness/mcp";

describe("brokered Streamable HTTP MCP", () => {
  it("A21-HTTP-TRANSPORT negotiates a session, bounds credentials to one origin, and terminates cleanly", async () => {
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

  it("A21-HTTP-OVERSIZE-CANCEL cancels an oversized response stream, stops that session, and preserves a healthy sibling", async () => {
    const cancelled = vi.fn();
    const methods: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      methods.push(init?.method === "DELETE" ? "DELETE" : String(body?.method));
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (body?.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }, {
          headers: { "mcp-session-id": "oversize-session" },
        });
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(400)));
          controller.enqueue(new TextEncoder().encode("y".repeat(400)));
        },
        cancel: cancelled,
      });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    });
    const supervisor = new McpSupervisor({ timeoutMs: 1_000, maxPayloadBytes: 512, idleTtlMs: 0 });
    supervisor.register("oversize", () => new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc", allowedOrigins: ["https://mcp.example.test"],
      fetch, maxPayloadBytes: 512, timeoutMs: 1_000,
    }));
    const healthyStop = vi.fn(async () => undefined);
    supervisor.register("healthy", () => ({
      start: async () => undefined,
      call: async () => ({ ok: true }),
      stop: healthyStop,
    }));

    await expect(supervisor.call("healthy", "read", {})).resolves.toEqual({ ok: true });
    await expect(supervisor.call("oversize", "read", {})).rejects.toThrow(/response exceeds the payload limit/);
    expect(cancelled).toHaveBeenCalled();
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
    expect(supervisor.isActive("oversize")).toBe(false);
    expect(supervisor.isActive("healthy")).toBe(true);
    await expect(supervisor.call("healthy", "read", {})).resolves.toEqual({ ok: true });
    await supervisor.stopAll();
    expect(healthyStop).toHaveBeenCalledOnce();
  });

  it("A21-CONCURRENT-START-SINGLE-FLIGHT shares one initialization and catalog across simultaneous first calls and deletes that session", async () => {
    let initializations = 0;
    let catalogs = 0;
    let calls = 0;
    const deletedSessions: string[] = [];
    const schema = {
      type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false,
    };
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (init?.method === "DELETE") {
        deletedSessions.push(headers.get("mcp-session-id") ?? "");
        return new Response(null, { status: 204 });
      }
      if (body?.method === "initialize") {
        initializations += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }, {
          headers: { "mcp-session-id": `session-${initializations}` },
        });
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body?.method === "tools/list") {
        catalogs += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: schema }] } });
      }
      calls += 1;
      return Response.json({ jsonrpc: "2.0", id: body?.id, result: { value: calls } });
    });
    const supervisor = new McpSupervisor({ timeoutMs: 1_000, idleTtlMs: 0 });
    supervisor.register("concurrent", () => new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc", allowedOrigins: ["https://mcp.example.test"], fetch,
    }), { expectedTools: [{ name: "echo", inputSchema: schema }] });

    await expect(Promise.all([
      supervisor.call("concurrent", "echo", { value: 1 }),
      supervisor.call("concurrent", "echo", { value: 2 }),
    ])).resolves.toEqual([{ value: 1 }, { value: 2 }]);
    expect(initializations).toBe(1);
    expect(catalogs).toBe(1);
    expect(calls).toBe(2);
    await supervisor.stopAll();
    expect(deletedSessions).toEqual(["session-1"]);
  });

  it("A21-CALLER-CANCEL-ISOLATION keeps shared initialize and catalog work alive for an uncanceled sibling", async () => {
    for (const cancelDuring of ["initialize", "catalog"] as const) {
      const initializeGate = deferred();
      const catalogGate = deferred();
      const initializeStarted = deferred();
      const catalogStarted = deferred();
      if (cancelDuring !== "initialize") initializeGate.resolve();
      if (cancelDuring !== "catalog") catalogGate.resolve();
      let initializations = 0;
      let catalogs = 0;
      let calls = 0;
      const deletedSessions: string[] = [];
      const schema = {
        type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false,
      };
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        if (init?.method === "DELETE") {
          deletedSessions.push(headers.get("mcp-session-id") ?? "");
          return new Response(null, { status: 204 });
        }
        if (body?.method === "initialize") {
          initializations += 1;
          initializeStarted.resolve();
          await waitForGate(initializeGate.promise, init?.signal);
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }, {
            headers: { "mcp-session-id": `${cancelDuring}-session` },
          });
        }
        if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body?.method === "tools/list") {
          catalogs += 1;
          catalogStarted.resolve();
          await waitForGate(catalogGate.promise, init?.signal);
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: schema }] } });
        }
        calls += 1;
        return Response.json({ jsonrpc: "2.0", id: body?.id, result: { value: calls } });
      });
      const supervisor = new McpSupervisor({ timeoutMs: 1_000, idleTtlMs: 0 });
      supervisor.register(cancelDuring, () => new StreamableHttpMcpTransport({
        url: "https://mcp.example.test/rpc", allowedOrigins: ["https://mcp.example.test"], fetch,
      }), { expectedTools: [{ name: "echo", inputSchema: schema }] });
      const controller = new AbortController();

      const initiator = supervisor.call(cancelDuring, "echo", { value: 1 }, controller.signal);
      await (cancelDuring === "initialize" ? initializeStarted.promise : catalogStarted.promise);
      const sibling = supervisor.call(cancelDuring, "echo", { value: 2 });
      const initiatorRejected = expect(initiator).rejects.toThrow(`cancel ${cancelDuring}`);
      controller.abort(new Error(`cancel ${cancelDuring}`));
      await initiatorRejected;
      if (cancelDuring === "initialize") initializeGate.resolve();
      else catalogGate.resolve();

      await expect(sibling).resolves.toEqual({ value: 1 });
      expect(initializations).toBe(1);
      expect(catalogs).toBe(1);
      expect(calls).toBe(1);
      expect(deletedSessions).toEqual([]);
      expect(supervisor.isActive(cancelDuring)).toBe(true);
      await supervisor.stopAll();
      expect(deletedSessions).toEqual([`${cancelDuring}-session`]);
    }
  });

  it("A21-CONCURRENT-IDLE-LIFECYCLE waits for every active call and resets idle expiry on a near-deadline call", async () => {
    vi.useFakeTimers();
    const slow = deferred();
    const nearDeadline = deferred();
    const deletedSessions: string[] = [];
    const schema = {
      type: "object", properties: { phase: { type: "string" } }, required: ["phase"], additionalProperties: false,
    };
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (init?.method === "DELETE") {
        deletedSessions.push(headers.get("mcp-session-id") ?? "");
        return new Response(null, { status: 204 });
      }
      if (body?.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }, {
          headers: { "mcp-session-id": "idle-session" },
        });
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body?.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: schema }] } });
      }
      const params = body?.params as { arguments?: { phase?: string } } | undefined;
      const phase = params?.arguments?.phase ?? "unknown";
      if (phase === "slow") await waitForGate(slow.promise, init?.signal);
      if (phase === "near-deadline") await waitForGate(nearDeadline.promise, init?.signal);
      return Response.json({ jsonrpc: "2.0", id: body?.id, result: { phase } });
    });
    const supervisor = new McpSupervisor({ timeoutMs: 1_000, idleTtlMs: 50 });
    supervisor.register("idle", () => new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc", allowedOrigins: ["https://mcp.example.test"], fetch,
    }), { expectedTools: [{ name: "echo", inputSchema: schema }] });

    try {
      const slowCall = supervisor.call("idle", "echo", { phase: "slow" });
      await expect(supervisor.call("idle", "echo", { phase: "fast" })).resolves.toEqual({ phase: "fast" });
      await vi.advanceTimersByTimeAsync(51);
      expect(deletedSessions).toEqual([]);
      expect(supervisor.isActive("idle")).toBe(true);

      slow.resolve();
      await expect(slowCall).resolves.toEqual({ phase: "slow" });
      await vi.advanceTimersByTimeAsync(49);
      const nearDeadlineCall = supervisor.call("idle", "echo", { phase: "near-deadline" });
      await vi.advanceTimersByTimeAsync(2);
      expect(deletedSessions).toEqual([]);
      expect(supervisor.isActive("idle")).toBe(true);

      nearDeadline.resolve();
      await expect(nearDeadlineCall).resolves.toEqual({ phase: "near-deadline" });
      await vi.advanceTimersByTimeAsync(50);
      expect(deletedSessions).toEqual(["idle-session"]);
      expect(supervisor.isActive("idle")).toBe(false);
    } finally {
      await supervisor.stopAll();
      vi.useRealTimers();
    }
  });

  it("A21-HTTP-LIFECYCLE-AUTHORITY aborts an ordinary in-flight request before deleting its session", async () => {
    const started = deferred();
    const deletedSessions: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (init?.method === "DELETE") {
        deletedSessions.push(headers.get("mcp-session-id") ?? "");
        return new Response(null, { status: 204 });
      }
      if (body?.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }, {
          headers: { "mcp-session-id": "abort-session" },
        });
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      started.resolve();
      await waitForGate(new Promise<void>(() => undefined), init?.signal);
      throw new Error("unreachable");
    });
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc", allowedOrigins: ["https://mcp.example.test"], fetch,
    });

    const call = transport.call("slow", {});
    const rejected = expect(call).rejects.toThrow(/transport stopped/);
    await started.promise;
    await transport.stop();
    await rejected;
    expect(deletedSessions).toEqual(["abort-session"]);
  });

  it("A21-HTTP-ORIGIN-POLICY rejects mutable origins, credential URLs, and remote plain HTTP", () => {
    expect(() => new StreamableHttpMcpTransport({ url: "https://other.test/rpc", allowedOrigins: ["https://mcp.test"] })).toThrow(/allowlisted/);
    expect(() => new StreamableHttpMcpTransport({ url: "https://user:pass@mcp.test/rpc", allowedOrigins: ["https://mcp.test"] })).toThrow(/credentials/);
    expect(() => new StreamableHttpMcpTransport({ url: "http://mcp.test/rpc", allowedOrigins: ["http://mcp.test"] })).toThrow(/requires HTTPS/);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForGate(gate: Promise<void>, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal?.reason ?? new Error("MCP request aborted")));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    gate.then(() => finish(resolve), (error) => finish(() => reject(error)));
  });
}
