import { execFile, spawn } from "node:child_process";
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
    LITE_HARNESS_MODE: "development",
  },
  detached: process.platform !== "win32",
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });

let report;
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

  report = {
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
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
} finally {
  await stopBenchmarkProcess(child);
  await removeBenchmarkDirectory(dataDir);
}
await writeFile(join(root, "docs", "performance-baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function stopBenchmarkProcess(processHandle) {
  if (!processHandle.pid) return;
  if (process.platform === "win32") {
    const graceful = await taskkillProcessTree(processHandle.pid, false);
    if (!graceful.ok) {
      const forced = await taskkillProcessTree(processHandle.pid, true);
      if (!forced.ok && !isExited(processHandle)) throw taskkillError(processHandle.pid, forced);
    }
    if (await waitForExit(processHandle, 15_000)) return;
    const forced = await taskkillProcessTree(processHandle.pid, true);
    if (!forced.ok && !isExited(processHandle)) throw taskkillError(processHandle.pid, forced);
    if (!(await waitForExit(processHandle, 5_000))) throw new Error(`Benchmark launcher ${processHandle.pid} did not exit after taskkill`);
    return;
  }
  if (isExited(processHandle)) return;
  processHandle.kill("SIGTERM");
  if (await waitForExit(processHandle, 15_000)) return;
  await forceKillProcessTree(processHandle.pid);
  if (!(await waitForExit(processHandle, 5_000))) throw new Error(`Benchmark launcher ${processHandle.pid} did not exit after SIGKILL`);
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return true;
  return await new Promise((resolveExit) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    processHandle.once("exit", () => finish(true));
  });
}

async function forceKillProcessTree(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function taskkillProcessTree(pid, force) {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  return await new Promise((resolveKill, rejectKill) => {
    execFile("taskkill.exe", args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        rejectKill(error);
        return;
      }
      resolveKill({ ok: !error, code: error?.code ?? 0, stderr: String(stderr ?? "").trim() });
    });
  });
}

function isExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

function taskkillError(pid, result) {
  return new Error(`taskkill failed for benchmark launcher ${pid} (exit ${result.code}): ${result.stderr || "unknown error"}`);
}

async function removeBenchmarkDirectory(path) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!error || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      lastError = error;
      await delay(250);
    }
  }
  throw lastError ?? new Error(`Could not remove benchmark directory ${path}`);
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
