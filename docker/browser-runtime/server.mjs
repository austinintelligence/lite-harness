import { createInterface } from "node:readline";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

let browser;
let context;
let page;
let policy = {};
let proxyServer;
let consoleRecords = [];
let networkRecords = [];
const input = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await dispatch(request.method, request.params ?? {});
    if (request.id !== undefined) send({ id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) send({ id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
});

async function dispatch(method, params) {
  if (method === "initialize") {
    policy = params.policy ?? {};
    if (params.proxyServer !== undefined) {
      const proxy = new URL(params.proxyServer);
      if (proxy.protocol !== "http:" || proxy.username || proxy.password) throw new Error("Invalid external browser proxy");
      proxyServer = proxy.toString();
    }
    if (params.remoteCdpEndpoint) {
      const endpoint = new URL(params.remoteCdpEndpoint);
      if (!["ws:", "wss:", "http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid remote CDP endpoint");
      browser = await chromium.connectOverCDP(endpoint.toString());
    } else {
      browser = await chromium.launch({
        headless: true,
        ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      });
    }
    await createContext();
    return { ok: true };
  }
  if (method === "profile.restore") {
    if (!browser || typeof params.data !== "string" || Buffer.byteLength(params.data) > 4 * 1024 * 1024) throw new Error("Invalid browser profile");
    const storageState = JSON.parse(params.data);
    await context?.close();
    await createContext(storageState);
    return { restored: true };
  }
  if (method === "profile.export") {
    if (!context) throw new Error("Browser sidecar is not initialized");
    return { data: JSON.stringify(await context.storageState()) };
  }
  if (method === "shutdown") {
    await browser?.close();
    queueMicrotask(() => process.exit(0));
    return { ok: true };
  }
  if (method !== "invoke" || !page) throw new Error("Browser sidecar is not initialized");
  return await invoke(params);
}

async function createContext(storageState) {
    consoleRecords = []; networkRecords = [];
    context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block", ...(storageState ? { storageState } : {}) });
    // Legacy standalone execution retains the in-process policy route. The
    // managed path always supplies proxyServer and enforces policy outside the
    // Chromium container through ExternalBrowserEgressBroker.
    if (!proxyServer) {
      await context.route("**/*", async (route) => {
        try {
          const response = await fetchPinned(route.request());
          await route.fulfill(response);
        }
        catch { await route.abort("blockedbyclient"); }
      });
    }
    await context.routeWebSocket(/.*/, (socket) => socket.close({ code: 1008, reason: "WebSockets are disabled by the browser broker" }));
    context.on("requestfinished", (request) => {
      networkRecords.push({ method: request.method(), url: request.url().slice(0, 2_048), resourceType: request.resourceType(), at: new Date().toISOString() });
      networkRecords = networkRecords.slice(-500);
    });
    page = await context.newPage();
    attachPageObservers(page);
}

async function invoke(command) {
  if (command.action === "navigate") {
    await assertAllowed(command.url);
    await page.goto(command.url, { waitUntil: "domcontentloaded" });
    return metadata();
  }
  if (command.action === "back") { await page.goBack(); return metadata(); }
  if (command.action === "forward") { await page.goForward(); return metadata(); }
  if (command.action === "reload") { await page.reload(); return metadata(); }
  if (command.action === "wait") {
    if (!Number.isInteger(command.milliseconds) || command.milliseconds < 0 || command.milliseconds > 30_000) throw new Error("Invalid browser wait");
    await page.waitForTimeout(command.milliseconds); return metadata();
  }
  if (command.action === "tabs") return { value: await tabList() };
  if (command.action === "new_tab") { page = await context.newPage(); attachPageObservers(page); return { ...await metadata(), value: await tabList() }; }
  if (command.action === "switch_tab") { page = tabById(command.tabId); return metadata(); }
  if (command.action === "close_tab") {
    const target = tabById(command.tabId); await target.close();
    page = context.pages()[0] ?? await context.newPage(); attachPageObservers(page);
    return { ...await metadata(), value: await tabList() };
  }
  if (command.action === "inspect") return { ...await metadata(), value: { console: consoleRecords.slice(-200), network: networkRecords.slice(-500) } };
  if (command.action === "scroll") {
    const x = Number(command.deltaX ?? 0); const y = Number(command.deltaY ?? 0);
    if (![x, y].every(Number.isFinite) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) throw new Error("Invalid browser scroll");
    await page.mouse.wheel(x, y); return metadata();
  }
  if (command.action === "keyboard") { await page.keyboard.press(command.key); return metadata(); }
  if (command.action === "snapshot") return await snapshot();
  if (command.action === "screenshot") {
    const data = await page.screenshot({ type: "png", fullPage: command.fullPage === true });
    return await artifact("screenshot.png", "image/png", data);
  }
  if (command.action === "pdf") {
    const data = await page.pdf({ format: "Letter" });
    return await artifact("page.pdf", "application/pdf", data);
  }
  if (command.action === "upload") {
    assertRef(command.ref);
    const data = Buffer.from(command.dataBase64, "base64");
    if (data.length > 16 * 1024 * 1024) throw new Error("Upload is too large");
    const path = join("/tmp", `upload-${Date.now()}-${safeName(command.name)}`);
    await writeFile(path, data, { mode: 0o600 });
    try { await page.locator(`[data-lite-ref="${command.ref}"]`).setInputFiles(path); }
    finally { await rm(path, { force: true }); }
    return metadata();
  }
  if (["click", "type", "select", "hover"].includes(command.action)) {
    assertRef(command.ref);
    const locator = page.locator(`[data-lite-ref="${command.ref}"]`);
    if (command.action === "click" && command.expectDownload) {
      const [download] = await Promise.all([page.waitForEvent("download"), locator.click()]);
      const stream = await download.createReadStream();
      const chunks = []; let size = 0;
      for await (const chunk of stream) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("Download is too large"); chunks.push(chunk); }
      return await artifact(safeName(download.suggestedFilename()), "application/octet-stream", Buffer.concat(chunks));
    }
    if (command.action === "click") await locator.click();
    if (command.action === "type") await locator.fill(command.text);
    if (command.action === "select") await locator.selectOption(command.value);
    if (command.action === "hover") await locator.hover();
    return metadata();
  }
  if (command.action === "drag") {
    assertRef(command.sourceRef); assertRef(command.targetRef);
    await page.locator(`[data-lite-ref="${command.sourceRef}"]`).dragTo(page.locator(`[data-lite-ref="${command.targetRef}"]`));
    return metadata();
  }
  throw new Error(`Unsupported browser action: ${command.action}`);
}

async function snapshot() {
  const elements = await page.locator("a,button,input,textarea,select,[role],[tabindex]").evaluateAll((nodes) => nodes.slice(0, 500).map((node, index) => {
    const ref = `e${index + 1}`;
    node.setAttribute("data-lite-ref", ref);
    return { ref, role: node.getAttribute("role") || node.tagName.toLowerCase(), name: node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 200) || node.getAttribute("name") || "" };
  }));
  return { ...await metadata(), snapshot: { text: (await page.locator("body").innerText()).slice(0, 200_000), elements } };
}

async function metadata() { return { url: page.url(), title: await page.title() }; }
async function artifact(name, mediaType, data) {
  if (data.length > 16 * 1024 * 1024) throw new Error("Browser artifact is too large");
  return { ...await metadata(), artifact: { name, mediaType, dataBase64: data.toString("base64"), sizeBytes: data.length } };
}
function assertRef(ref) { if (!/^e[1-9][0-9]{0,4}$/.test(ref)) throw new Error("Invalid browser element reference"); }
function safeName(name) { return String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "file"; }

function attachPageObservers(target) {
  if (target.__liteObserved) return;
  target.__liteObserved = true;
  target.on("console", (message) => {
    consoleRecords.push({ type: message.type(), text: message.text().slice(0, 2_000), at: new Date().toISOString() });
    consoleRecords = consoleRecords.slice(-200);
  });
  target.on("dialog", async (dialog) => {
    consoleRecords.push({ type: "dialog", text: `${dialog.type()}: ${dialog.message()}`.slice(0, 2_000), at: new Date().toISOString() });
    await dialog.dismiss().catch(() => undefined);
  });
}

function tabById(tabId) {
  if (!/^tab-[1-9][0-9]{0,3}$/.test(tabId)) throw new Error("Invalid browser tab id");
  const target = context.pages()[Number(tabId.slice(4)) - 1];
  if (!target) throw new Error("Browser tab is unavailable");
  return target;
}

async function tabList() {
  return await Promise.all(context.pages().slice(0, 32).map(async (candidate, index) => ({
    tabId: `tab-${index + 1}`, active: candidate === page, url: candidate.url(), title: await candidate.title(),
  })));
}

async function assertAllowed(rawUrl) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Blocked browser protocol");
  if (url.username || url.password) throw new Error("Blocked URL credentials");
  if (policy.allowedOrigins && !policy.allowedOrigins.includes(url.origin)) throw new Error("Blocked browser origin");
  // The Chromium container intentionally has no external DNS route. The
  // external proxy resolves and pins destinations for the managed path.
  if (proxyServer) return { url, addresses: [] };
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!policy.allowPrivateNetworks && addresses.some(isPrivate)) throw new Error("Blocked private network");
  return { url, addresses };
}

async function fetchPinned(request) {
  const { url, addresses } = await assertAllowed(request.url());
  const address = addresses[0];
  if (!address) throw new Error("Browser hostname did not resolve");
  const headers = { ...request.headers(), host: url.host };
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
  const body = request.postDataBuffer() ?? undefined;
  if (body && body.length > 16 * 1024 * 1024) throw new Error("Browser request body exceeds broker limit");
  const maxBytes = Number.isSafeInteger(policy.maxResponseBytes) ? Math.min(policy.maxResponseBytes, 64 * 1024 * 1024) : 32 * 1024 * 1024;
  return await new Promise((resolveRequest, reject) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = transport({
      protocol: url.protocol, hostname: address, port: url.port || undefined,
      method: request.method(), path: `${url.pathname}${url.search}`, headers,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      timeout: 30_000,
    }, (response) => {
      const chunks = []; let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) response.destroy(new Error("Browser response exceeds broker limit"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        const responseHeaders = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name) && name !== "content-length") {
            responseHeaders[name] = Array.isArray(value) ? value.join("\n") : value;
          }
        }
        resolveRequest({ status: response.statusCode ?? 502, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
    });
    outgoing.once("timeout", () => outgoing.destroy(new Error("Browser request timed out")));
    outgoing.once("error", reject);
    if (body) outgoing.end(body); else outgoing.end();
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function isPrivate(address) {
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return isPrivate(value.slice(7));
  if (["::1", "::"].includes(value) || /^fe[89ab]/.test(value) || value.startsWith("fc") ||
      value.startsWith("fd") || value.startsWith("ff") || value.startsWith("2001:db8:")) return true;
  const parts = value.split(".").map(Number); if (parts.length !== 4) return false;
  const [a, b] = parts; return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224;
}
