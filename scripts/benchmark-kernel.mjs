import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(join(tmpdir(), "lite-harness-benchmark-"));
const port = await freePort();
const appToken = "benchmark-app-token";
const startedAt = performance.now();
const child = spawn(process.execPath, ["--import", "tsx", "apps/launcher/src/main.ts", "--data-dir", dataDir], {
  cwd: root,
  env: {
    ...process.env,
    LITE_HARNESS_APP_TOKEN: appToken,
    LITE_HARNESS_INTERNAL_TOKEN: "benchmark-internal-token",
    LITE_HARNESS_MANAGER_SOCKET: process.platform === "win32"
      ? `\\\\.\\pipe\\lite-harness-benchmark-${process.pid}`
      : join(dataDir, "manager.sock"),
    LITE_HARNESS_HOST: "127.0.0.1",
    LITE_HARNESS_PORT: String(port),
    LITE_HARNESS_PROVIDER: "fake",
    LITE_HARNESS_RUNTIME: "fake",
  },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });

try {
  const ready = await pollJson(`http://127.0.0.1:${port}/readyz`, 20_000);
  const startupMs = performance.now() - startedAt;
  const health = await fetchJson(`http://127.0.0.1:${port}/healthz`);
  const runStartedAt = performance.now();
  const created = await fetchJson(`http://127.0.0.1:${port}/v1/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${appToken}`,
      "content-type": "application/json",
      "idempotency-key": "kernel-benchmark",
      "x-lite-tenant-id": "benchmark",
      "x-lite-user-id": "benchmark",
    },
    body: JSON.stringify({ agent: "coder", workspace: "benchmark", input: "Create hello.txt" }),
  });
  let terminal;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    terminal = await fetchJson(`http://127.0.0.1:${port}/v1/runs/${created.runId}`, {
      headers: {
        authorization: `Bearer ${appToken}`,
        "x-lite-tenant-id": "benchmark",
        "x-lite-user-id": "benchmark",
      },
    });
    if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(terminal.status)) break;
    await delay(25);
  }
  if (!terminal || terminal.status !== "SUCCEEDED") throw new Error(`Benchmark run did not succeed: ${terminal?.status ?? "unknown"}`);

  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    lane: "model-free deterministic kernel benchmark",
    provider: "fake",
    runtime: "in-memory",
    startupReadyMs: Number(startupMs.toFixed(1)),
    runTerminalMs: Number((performance.now() - runStartedAt).toFixed(1)),
    gatewayRssBytes: health.rssBytes,
    managerRssBytes: ready.dependencies.manager.rssBytes,
    terminalStatus: terminal.status,
    note: "This measures the process/kernel path only; credentialed inference uses the Hermes test wrapper.",
  };
  await writeFile(join(root, "docs", "performance-baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(12_000)]);
  await rm(dataDir, { recursive: true, force: true });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function pollJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await fetchJson(url); }
    catch (error) { lastError = error; await delay(50); }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate benchmark port");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
