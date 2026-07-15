import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { isIP, createConnection } from "node:net";

const MAX_TUNNEL_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const policy = decodePolicy(process.env.LITE_BROWSER_PROXY_POLICY);

const server = createServer(async (request, response) => {
  try {
    if (!request.url) throw new Error("Proxy request URL is missing");
    const target = new URL(request.url);
    if (target.protocol !== "http:") throw new Error("Only HTTP proxy requests are supported outside CONNECT");
    const address = await approve(target);
    const headers = sanitizeHeaders(request.headers, target.host);
    const upstream = httpRequest({
      host: address,
      port: Number(target.port || 80),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, sanitizeResponseHeaders(upstreamResponse.headers));
      let bytes = 0;
      upstreamResponse.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_TUNNEL_BYTES) {
          upstreamResponse.destroy(new Error("Browser proxy response exceeded byte limit"));
          response.destroy();
        }
      });
      upstreamResponse.pipe(response);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Browser proxy request timed out")));
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(error.message);
    });
    let requestBytes = 0;
    request.on("data", (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes > MAX_TUNNEL_BYTES) {
        request.destroy(new Error("Browser proxy request exceeded byte limit"));
        upstream.destroy();
      }
    });
    request.pipe(upstream);
  } catch (error) {
    response.writeHead(403, { "content-type": "text/plain", connection: "close" });
    response.end(error instanceof Error ? error.message : "Browser proxy denied request");
  }
});

server.on("connect", async (request, client, head) => {
  let upstream;
  try {
    const authority = parseAuthority(request.url);
    const target = new URL(`https://${formatAuthority(authority.hostname, authority.port)}`);
    const address = await approve(target);
    upstream = createConnection({ host: address, port: authority.port, timeout: REQUEST_TIMEOUT_MS });
    await new Promise((resolve, reject) => {
      upstream.once("connect", resolve);
      upstream.once("timeout", () => reject(new Error("Browser proxy tunnel timed out")));
      upstream.once("error", reject);
    });
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    bindBoundedTunnel(client, upstream);
  } catch (error) {
    upstream?.destroy();
    client.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
});

server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
server.listen(8080, "0.0.0.0");

async function approve(url) {
  if (url.username || url.password) throw new Error("Browser URL must not contain credentials");
  if (policy.allowedOrigins && !policy.allowedOrigins.includes(url.origin)) throw new Error(`Browser origin is not allowed: ${url.origin}`);
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : (await lookup(url.hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error("Browser hostname did not resolve");
  if (!policy.allowPrivateNetworks && addresses.some(isPrivateAddress)) throw new Error("Browser destination is private or reserved");
  return addresses[0];
}

function decodePolicy(encoded) {
  if (!encoded || encoded.length > 64 * 1024) throw new Error("Browser proxy policy is missing or too large");
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser proxy policy is invalid");
  if (value.allowedOrigins !== undefined) {
    if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length > 256) throw new Error("Browser proxy origin policy is invalid");
    value.allowedOrigins = value.allowedOrigins.map((origin) => {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error("Browser proxy origin is invalid");
      return origin;
    });
  }
  if (value.allowPrivateNetworks !== undefined && typeof value.allowPrivateNetworks !== "boolean") throw new Error("Browser private-network policy is invalid");
  return value;
}

function parseAuthority(value) {
  if (!value || value.length > 512 || value.includes("@")) throw new Error("Browser proxy authority is invalid");
  const url = new URL(`https://${value}`);
  const port = Number(url.port || 443);
  if (url.pathname !== "/" || url.search || url.hash || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Browser proxy authority is invalid");
  return { hostname: url.hostname, port };
}

function formatAuthority(hostname, port) {
  return `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

function bindBoundedTunnel(client, upstream) {
  let bytes = 0;
  const account = (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_TUNNEL_BYTES) {
      client.destroy(new Error("Browser proxy tunnel exceeded byte limit"));
      upstream.destroy();
    }
  };
  client.on("data", account);
  upstream.on("data", account);
  client.setTimeout(REQUEST_TIMEOUT_MS, () => client.destroy());
  upstream.setTimeout(REQUEST_TIMEOUT_MS, () => upstream.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}

function sanitizeHeaders(headers, host) {
  const clean = { ...headers, host };
  for (const name of ["connection", "proxy-authorization", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]) delete clean[name];
  return clean;
}

function sanitizeResponseHeaders(headers) {
  const clean = { ...headers };
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "trailer", "transfer-encoding", "upgrade"]) delete clean[name];
  return clean;
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  if (mapped.includes(".")) {
    const parts = mapped.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0)
      || (a === 192 && b === 168) || (a === 198 && [18, 19, 51].includes(b))
      || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")
    || normalized.startsWith("2001:db8:") || normalized.startsWith("ff");
}
