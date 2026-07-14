import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagerInstanceLock, probeManagerEndpoint } from "@lite-harness/operations";
import { LITE_IPC_PROTOCOL_VERSION } from "@lite-harness/contracts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("versioned local IPC instance ownership", () => {
  it("BD-006-REGRESSION refuses a second live Manager owner", async () => {
    const root = await temporaryRoot();
    const socketPath = endpoint(root, "manager");
    const first = lock(root, socketPath);
    const contender = lock(root, socketPath);
    await first.acquire();
    cleanup.push(() => first.release());

    await expect(contender.acquire()).rejects.toThrow(/already active/);
    expect(JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(first.ownerPath, "utf8"))))
      .toMatchObject({ instanceId: first.owner.instanceId, protocolVersion: LITE_IPC_PROTOCOL_VERSION });
  });

  it("reclaims a dead owner without trusting its stale endpoint metadata", async () => {
    const root = await temporaryRoot();
    const socketPath = endpoint(root, "stale");
    const lockPath = join(root, "manager.lock");
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      schemaVersion: 1,
      instanceId: "dead-instance",
      pid: 2_147_483_647,
      socketPath,
      protocolVersion: LITE_IPC_PROTOCOL_VERSION,
      startedAt: "2000-01-01T00:00:00.000Z",
    }), { mode: 0o600 });

    const replacement = lock(root, socketPath);
    await replacement.acquire();
    cleanup.push(() => replacement.release());
    expect(replacement.owner.instanceId).not.toBe("dead-instance");
  });

  it("never displaces a live endpoint without lock ownership", async () => {
    const root = await temporaryRoot();
    const socketPath = endpoint(root, "orphan");
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, role: "manager", protocolVersion: LITE_IPC_PROTOCOL_VERSION }));
    });
    await listen(server, socketPath);
    cleanup.push(() => close(server));

    const candidate = lock(root, socketPath);
    if (process.platform === "win32") {
      // Named pipes cannot be unlinked. The later listen attempt remains the
      // authoritative exclusion boundary when no lock metadata exists.
      await candidate.acquire();
      cleanup.push(() => candidate.release());
    } else {
      await expect(candidate.acquire()).rejects.toThrow(/live Manager endpoint/);
      expect(await import("node:fs/promises").then(({ lstat }) => lstat(socketPath).then((value) => value.isSocket()))).toBe(true);
    }
    expect(await probeManagerEndpoint(socketPath, LITE_IPC_PROTOCOL_VERSION, 100)).toBe(true);
  });
});

function lock(dataDir: string, socketPath: string): ManagerInstanceLock {
  return new ManagerInstanceLock({ dataDir, socketPath, protocolVersion: LITE_IPC_PROTOCOL_VERSION, probeTimeoutMs: 100 });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lite-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function endpoint(root: string, suffix: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\lite-harness-test-${process.pid}-${Date.now()}-${suffix}`
    : join(root, `${suffix}.sock`);
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
