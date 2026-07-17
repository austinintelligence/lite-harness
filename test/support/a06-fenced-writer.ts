import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DockerToolRuntime } from "@lite-harness/runtime-docker";
import type { InternalPrincipal, ToolCall } from "@lite-harness/contracts";
import type { ToolExecutionContext } from "@lite-harness/runtime";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const role = required("LITE_A06_ROLE") as "stale" | "resumed";
const databasePath = required("LITE_A06_DATABASE");
const markerRoot = required("LITE_A06_MARKERS");
const image = required("LITE_A06_IMAGE");
const installationId = required("LITE_A06_INSTALLATION");
const workspaceId = required("LITE_A06_WORKSPACE");
const principal = JSON.parse(required("LITE_A06_PRINCIPAL")) as InternalPrincipal;
const store = new SqliteRunStore(databasePath);
const runtime = new DockerToolRuntime({
  image,
  installationId,
  containerStore: store,
  validateExecutionLease: (params) => hasActiveFence(store, params),
});

try {
  mkdirSync(markerRoot, { recursive: true });
  const result = role === "stale" ? await staleWriter() : await resumedWriter();
  process.stdout.write(`A06_RESULT ${JSON.stringify({ role, pid: process.pid, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}

async function staleWriter(): Promise<Record<string, unknown>> {
  const runId = `a06-process-stale-${process.pid}`;
  store.createOrGetRun(runId, { agent: "coder", workspace: workspaceId, input: "stale process", idempotencyKey: runId, principal });
  const attempt = store.createRunAttempt(runId, `attempt-${runId}`);
  const lease = store.acquireWorkspaceLease(workspaceId, runId, 250);
  if (!lease) throw new Error("A06 stale process could not acquire its initial lease");
  writeFileSync(`${markerRoot}/stale-ready`, "ready\n", { encoding: "utf8" });
  await waitForFile(`${markerRoot}/resumed-ready`, 15_000);
  let staleMutationRejected = false;
  try {
    await runtime.execute({
      runId, attemptId: attempt.id, workspaceId, principal, fencingToken: lease.fencingToken,
      call: toolCall("stale-write", "write_file", { path: "stale-process.txt", content: "must not land" }),
    });
  } catch (error) {
    if (!/Workspace fence is not active/i.test(error instanceof Error ? error.message : String(error))) throw error;
    staleMutationRejected = true;
  }
  writeFileSync(`${markerRoot}/stale-done`, "done\n", { encoding: "utf8" });
  return { staleMutationRejected, runtimeContainers: store.listRuntimeContainers().length };
}

async function resumedWriter(): Promise<Record<string, unknown>> {
  await delay(100);
  const runId = `a06-process-resumed-${process.pid}`;
  store.createOrGetRun(runId, { agent: "coder", workspace: workspaceId, input: "resumed process", idempotencyKey: runId, principal });
  const attempt = store.createRunAttempt(runId, `attempt-${runId}`);
  const deadline = Date.now() + 15_000;
  let lease = store.acquireWorkspaceLease(workspaceId, runId, 60_000);
  while (!lease && Date.now() < deadline) {
    await delay(50);
    lease = store.acquireWorkspaceLease(workspaceId, runId, 60_000);
  }
  if (!lease) throw new Error("A06 resumed process could not acquire the expired lease");
  writeFileSync(`${markerRoot}/resumed-ready`, "ready\n", { encoding: "utf8" });
  const write = await runtime.execute({
    runId, attemptId: attempt.id, workspaceId, principal, fencingToken: lease.fencingToken,
    call: toolCall("resumed-write", "write_file", { path: "resumed-process.txt", content: "fenced process owner wins\n" }),
  });
  if (!write.ok) throw new Error(`A06 resumed process write failed: ${write.content}`);
  const read = await runtime.execute({
    runId, attemptId: attempt.id, workspaceId, principal, fencingToken: lease.fencingToken,
    call: toolCall("resumed-read", "read_file", { path: "resumed-process.txt" }),
  });
  await waitForFile(`${markerRoot}/stale-done`, 15_000);
  await runtime.removeWorkspace(workspaceId, principal);
  return { resumedMutationSucceeded: read.ok === true, content: read.content };
}

function toolCall(id: string, name: string, arguments_: Record<string, unknown>): ToolCall {
  return { id, name, arguments: arguments_ };
}

function hasActiveFence(store: SqliteRunStore, params: ToolExecutionContext): boolean {
  if (!params.runId || !params.attemptId || !params.principal || params.fencingToken === undefined) return false;
  const run = store.getRun(params.runId);
  if (!run || run.workspaceId !== params.workspaceId || run.appId !== params.principal.appId ||
      run.tenantId !== params.principal.tenantId || run.userId !== params.principal.userId) return false;
  const attempt = store.listRunAttempts(run.id).findLast((item) => item.status === "RUNNING");
  const lease = store.getWorkspaceLease(run.workspaceId, run.id);
  return attempt?.id === params.attemptId && lease?.fencingToken === params.fencingToken && store.validateWorkspaceLease(lease);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for A06 marker ${path}`);
    await delay(25);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
