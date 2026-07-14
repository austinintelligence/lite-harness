import { createInterface } from "node:readline";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

let browser;
let context;
let page;
let policy = {};
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
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      try { await assertAllowed(route.request().url()); await route.continue(); }
      catch { await route.abort("blockedbyclient"); }
    });
    page = await context.newPage();
    return { ok: true };
  }
  if (method === "shutdown") {
    await browser?.close();
    queueMicrotask(() => process.exit(0));
    return { ok: true };
  }
  if (method !== "invoke" || !page) throw new Error("Browser sidecar is not initialized");
  return await invoke(params);
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

async function assertAllowed(rawUrl) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Blocked browser protocol");
  if (url.username || url.password) throw new Error("Blocked URL credentials");
  if (policy.allowedOrigins && !policy.allowedOrigins.includes(url.origin)) throw new Error("Blocked browser origin");
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!policy.allowPrivateNetworks && addresses.some(isPrivate)) throw new Error("Blocked private network");
}

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
