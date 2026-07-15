import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JsonLineRpcClient, ProcessRpcError, runJsonLineProcess } from "@lite-harness/process-rpc";

const fixture = fileURLToPath(new URL("./fixtures/process-peer.mjs", import.meta.url));
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("process RPC safety", () => {
  it("BD-027-REGRESSION reaps timed-out side effects, bounds partial lines, and isolates child HOME", async () => {
    await expect(runJsonLineProcess(
      { command: process.execPath, args: [fixture, "process-partial"] },
      { maxLineBytes: 1_024, timeoutMs: 5_000, onMessage: () => undefined },
    )).rejects.toMatchObject({ code: "line_too_large" });

    let childHome = "";
    await runJsonLineProcess(
      { command: process.execPath, args: [fixture, "process-home"] },
      { onMessage: (message) => { childHome = String((message as { home?: unknown }).home ?? ""); } },
    );
    expect(childHome).not.toBe(process.env.HOME);
    expect(childHome).not.toBe(process.env.USERPROFILE);
    expect(existsSync(childHome)).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "lite-process-side-effect-"));
    cleanup.push(root);
    const marker = join(root, "late.txt");
    await expect(runJsonLineProcess(
      { command: process.execPath, args: [fixture, "process-side-effect", marker] },
      { timeoutMs: 25, onMessage: () => undefined },
    )).rejects.toMatchObject({ code: "process_timeout" });
    await delay(300);
    expect(existsSync(marker)).toBe(false);
  });

  it("never spawns pre-aborted work and removes request abort listeners after settlement", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-aborted sentinel"));
    await expect(runJsonLineProcess(
      { command: "this-command-must-never-spawn" },
      { signal: preAborted.signal, onMessage: () => undefined },
    )).rejects.toThrow(/pre-aborted sentinel/);

    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;
    const client = new JsonLineRpcClient({ command: process.execPath, args: [fixture, "rpc"] });
    await expect(client.request("health", undefined, { signal: controller.signal })).resolves.toEqual({ ok: true });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(before);
    await client.stop();
  });

  it("does not reject an RPC timeout until the child is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "lite-rpc-side-effect-"));
    cleanup.push(root);
    const marker = join(root, "late-rpc.txt");
    const client = new JsonLineRpcClient(
      { command: process.execPath, args: [fixture, "rpc-side-effect", marker] },
      { requestTimeoutMs: 25 },
    );
    const error = await client.request("mutate").catch((caught) => caught);
    expect(error).toBeInstanceOf(ProcessRpcError);
    expect(error).toMatchObject({ code: "request_timeout" });
    expect(client.running).toBe(false);
    await delay(300);
    expect(existsSync(marker)).toBe(false);
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
