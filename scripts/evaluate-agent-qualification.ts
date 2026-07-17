import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiteHarnessClient } from "@lite-harness/sdk";
import type { RunEvent, RunRecord } from "@lite-harness/contracts";
import { dockerWorkspaceVolumeName } from "@lite-harness/runtime-docker";

const root = resolve(import.meta.dirname, "..");
const mode = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "corpus";
const evidenceIndex = process.argv.indexOf("--evidence");
const evidencePath = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
const provider = process.env.LITE_HARNESS_PROVIDER?.trim();
const model = process.env.LITE_HARNESS_MODEL?.trim();
const providerBaseUrl = process.env.LITE_HARNESS_PROVIDER_BASE_URL?.trim() ?? "https://openrouter.ai/api/v1/";
const isOpenRouter = provider === "openrouter" && model === "openrouter/free" && /^https:\/\/openrouter\.ai\/api\/v1\/?$/i.test(providerBaseUrl);
const isHermes = provider === "openai-compatible" && model === "gpt-5.6-luna" && providerBaseUrl === "http://127.0.0.1:8645/v1";
if (!isOpenRouter && !isHermes) {
  throw new Error("Qualification requires either OpenRouter openrouter/free or the exact local Hermes gpt-5.6-luna route");
}
if (!process.env.LITE_HARNESS_PROVIDER_API_KEY?.trim()) throw new Error("LITE_HARNESS_PROVIDER_API_KEY must be supplied in the process environment");
const evaluationRoute = isHermes ? "local-hermes-openai-compatible" : "openrouter";

const runtimeImage = immutableImage(process.env.LITE_HARNESS_RUNTIME_IMAGE, "lite-harness/tool-runtime:dev");
const browserImage = process.env.LITE_HARNESS_TEST_BROWSER_IMAGE?.trim()
  ? immutableImage(process.env.LITE_HARNESS_TEST_BROWSER_IMAGE, "lite-harness/browser-runtime:dev")
  : undefined;
const suffix = randomUUID().replaceAll("-", "");
const fixtureRoot = mkdtempSync(join(tmpdir(), `lite-agent-${mode}-`));
const dataDir = join(fixtureRoot, "data");
const contextPath = join(fixtureRoot, "operator-context.txt");
const contextText = `CORPUS_CONTEXT_MARKER_${suffix}: canonical context must remain exact.`;
writeFileSync(contextPath, contextText, { encoding: "utf8" });
const contextBlockId = `operator-${createHash("sha256").update(contextText).digest("hex")}`;
const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\lite-agent-${suffix}` : join(fixtureRoot, "manager.sock");
const appToken = `lite-agent-app-token-${suffix}`;
const internalToken = `lite-agent-internal-token-${suffix}`;
const owner = { appId: `qualification-app-${suffix}`, tenantId: `qualification-tenant-${suffix}`, userId: `qualification-user-${suffix}` };
const agentId = `qualification-agent-${suffix}`;
const toolSet = [
  "write_file", "read_file", "shell_exec", "artifact_publish", "browser_open", "browser_action", "browser_close",
  "memory_add", "memory_search", "memory_get", "context_fetch_exact",
];
let manager: ChildProcessWithoutNullStreams | undefined;
let gateway: ChildProcessWithoutNullStreams | undefined;
let managerLogs = "";
let gatewayLogs = "";
let browserServer: ReturnType<typeof createServer> | undefined;
let browserOrigin = "";
let qualificationEnvironment: NodeJS.ProcessEnv | undefined;
let qualificationGatewayPort: number | undefined;
const createdWorkspaceIds: string[] = [];
let report!: Record<string, unknown>;

try {
  const browserPort = await startBrowserFixture();
  browserOrigin = `http://host.docker.internal:${browserPort}`;
  const gatewayPort = await freePort();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    LITE_HARNESS_CONFIG_VERSION: "1",
    LITE_HARNESS_DATA_DIR: dataDir,
    LITE_HARNESS_MANAGER_SOCKET: socketPath,
    LITE_HARNESS_INTERNAL_TOKEN: internalToken,
    LITE_HARNESS_APP_TOKEN: appToken,
    LITE_HARNESS_APP_ID: owner.appId,
    LITE_HARNESS_TENANT_ID: owner.tenantId,
    LITE_HARNESS_USER_ID: owner.userId,
    LITE_HARNESS_HOST: "127.0.0.1",
    LITE_HARNESS_PORT: String(gatewayPort),
    LITE_HARNESS_PROVIDER: provider!,
    LITE_HARNESS_PROVIDER_BASE_URL: providerBaseUrl,
    LITE_HARNESS_MODEL: model!,
    LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION: "0",
    LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION: "0",
    LITE_HARNESS_RUNTIME: "docker",
    LITE_HARNESS_RUNTIME_IMAGE: runtimeImage,
    LITE_HARNESS_MODE: "production",
    LITE_HARNESS_OFFLINE: "false",
    LITE_HARNESS_ENABLE_MEMORY: "true",
    LITE_HARNESS_REQUIRE_APPROVALS: "true",
    LITE_HARNESS_APPROVAL_TIMEOUT_MS: "60000",
    LITE_HARNESS_CONTEXT_FILE: contextPath,
    LITE_HARNESS_CONTEXT_KIND: "source",
    LITE_HARNESS_CONTEXT_OPTIMIZATION: "false",
    LITE_HARNESS_ENABLE_PLUGINS: "false",
    LITE_HARNESS_ENABLE_CACHE_CATALOG: "false",
    LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT: "false",
    LITE_HARNESS_SNAPSHOT_KEY: Buffer.alloc(32, 12).toString("base64"),
    ...(browserImage ? {
      LITE_HARNESS_BROWSER_IMAGE: browserImage,
      LITE_HARNESS_BROWSER_ALLOWED_ORIGINS: browserOrigin,
      LITE_HARNESS_BROWSER_ALLOW_PRIVATE: "true",
      LITE_HARNESS_BROWSER_IDLE_MS: "60000",
    } : {}),
  };
  qualificationEnvironment = environment;
  qualificationGatewayPort = gatewayPort;
  manager = startProcess("manager", join(root, "apps", "manager", "src", "main.ts"), environment);
  attachLogs(manager, "manager");
  gateway = startProcess("gateway", join(root, "apps", "gateway", "src", "main.ts"), environment);
  attachLogs(gateway, "gateway");
  const port = await waitForReady([manager, gateway], gatewayPort);
  const client = new LiteHarnessClient({ baseUrl: `http://127.0.0.1:${port}`, token: appToken });
  await client.createAgent({
    id: agentId,
    name: "OpenRouter free qualification agent",
    instructions: "You are being evaluated on exact tool use. Follow each task literally, use only the allowed tools, verify outputs before finishing, and never claim a step succeeded unless its tool result proves it.",
    modelCapabilities: ["text", "tools"],
    allowedTools: toolSet,
    defaultBudget: { maxTurns: 12, maxToolCalls: 24, totalTimeoutMs: 300_000, modelIdleTimeoutMs: 120_000, commandTimeoutMs: 45_000 },
  });

  const allTasks = corpusTasks(browserOrigin, Boolean(browserImage));
  const tasks = mode === "browser"
    ? allTasks.filter((task) => task.id.startsWith("browser-"))
    : mode === "browser-download"
      ? allTasks.filter((task) => task.id === "browser-download")
      : allTasks;
  if ((mode === "browser" || mode === "browser-download") && tasks.length === 0) throw new Error("Browser qualification mode requires a browser image");
  const taskResults: Record<string, unknown>[] = [];
  const metrics = createMetricsSampler(dataDir);
  metrics.start();
  try {
    for (const task of tasks) {
      if (task.beforeRun) await task.beforeRun();
      const startedAt = performance.now();
      const workspaceId = `qualification-${task.id}-${suffix}`;
      createdWorkspaceIds.push(workspaceId);
      await client.createWorkspace({ id: workspaceId });
      const created = await client.createRun({
        agent: agentId,
        workspace: workspaceId,
        input: task.input,
        budget: { maxTurns: 12, maxToolCalls: 24, totalTimeoutMs: task.timeoutMs ?? 300_000, modelIdleTimeoutMs: 120_000, commandTimeoutMs: 45_000 },
      }, `qualification-${task.id}-${suffix}`);
      const observed = await observeRun(client, created.runId, task.cancelAfterMs);
      let lifecycle: Record<string, unknown> | undefined;
      let lifecycleError: string | undefined;
      if (task.afterRun) {
        try {
          lifecycle = await task.afterRun({ client, runId: created.runId, workspaceId });
        } catch (error) {
          lifecycleError = error instanceof Error ? error.message : String(error);
        }
      }
      const evaluation = task.verify(observed);
      const expectedTerminal = task.id === "cancellation" ? observed.run.status === "CANCELLED" : observed.run.status === "SUCCEEDED";
      const passed = evaluation.passed && expectedTerminal && !lifecycleError && (lifecycle?.passed !== false);
      taskResults.push({
        id: task.id,
        allowedTools: task.allowedTools,
        runId: created.runId,
        workspaceId,
        status: observed.run.status,
        passed,
        reason: lifecycleError
          ? `${evaluation.reason}; lifecycle evidence failed: ${lifecycleError}`
          : expectedTerminal ? evaluation.reason : `${evaluation.reason}; terminal status was ${observed.run.status}`,
        latencyMs: Number((performance.now() - startedAt).toFixed(1)),
        toolCalls: observed.toolCalls,
        approvals: observed.approvals,
        usage: usageSummary(observed.events),
        eventCount: observed.events.length,
        diagnostics: observationDiagnostics(observed),
        lifecycle,
        workspace: task.workspacePath ? inspectWorkspaceFile(workspaceId, workspacePath(task.workspacePath), runtimeImage, owner, task.workspaceExpected) : undefined,
      });
    }
  } finally {
    metrics.stop();
  }
  const passed = taskResults.length === tasks.length && taskResults.every((item) => item.passed === true);
  report = {
    schemaVersion: 1,
    kind: "one-agent-real-task-corpus",
    result: passed ? "pass" : "fail",
    sourceCommit: gitOutput(["rev-parse", "HEAD"]),
    sourceDirty: gitOutput(["status", "--porcelain"]).length > 0,
    provider: { route: evaluationRoute, baseUrl: environment.LITE_HARNESS_PROVIDER_BASE_URL, model: model!, credential: "non-empty-placeholder-only" },
    publicClient: "@lite-harness/sdk LiteHarnessClient",
    taskCount: tasks.length,
    passedTasks: taskResults.filter((item) => item.passed === true).length,
    failedTasks: taskResults.filter((item) => item.passed !== true).length,
    tasks: taskResults,
    measurements: metrics.report(),
    browser: { image: browserImage ?? null, fixtureOrigin: browserOrigin || null },
    context: { blockId: contextBlockId, exactTextBytes: Buffer.byteLength(contextText) },
  };
} catch (error) {
  report = {
    schemaVersion: 1,
    kind: "one-agent-real-task-corpus",
    result: "fail",
    sourceCommit: gitOutput(["rev-parse", "HEAD"]),
    sourceDirty: gitOutput(["status", "--porcelain"]).length > 0,
    provider: { route: evaluationRoute, model: model!, credential: "non-empty-placeholder-only" },
    error: error instanceof Error ? error.message : String(error),
    managerLogs,
    gatewayLogs,
  };
  process.exitCode = 1;
} finally {
  await stopProcess(gateway);
  await stopProcess(manager);
  if (browserServer) await closeServer(browserServer);
  removeManagedContainers(dataDir);
  removeManagedNetworks(dataDir);
  removeManagedVolumes(createdWorkspaceIds, owner);
  const remainingContainers = managedContainers(dataDir);
  const remainingNetworks = managedNetworks(dataDir);
  const remainingVolumes = managedWorkspaceVolumes(createdWorkspaceIds, owner);
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* temporary fixture only */ }
  report = {
    ...report,
    cleanup: {
      managedContainers: remainingContainers,
      managedNetworks: remainingNetworks,
      managedVolumes: remainingVolumes,
      status: remainingContainers.length === 0 && remainingNetworks.length === 0 && remainingVolumes.length === 0 ? "clean" : "blocked",
    },
  };
  if (evidencePath) {
    const absolute = resolve(root, evidencePath);
    writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

interface TaskObservation {
  run: RunRecord;
  events: RunEvent[];
  toolCalls: string[];
  approvals: string[];
  streamError?: string;
}

interface CorpusTask {
  id: string;
  input: string;
  allowedTools: string[];
  marker?: string;
  workspacePath?: string;
  workspaceExpected?: string;
  timeoutMs?: number;
  cancelAfterMs?: number;
  beforeRun?: () => Promise<void>;
  afterRun?: (context: { client: LiteHarnessClient; runId: string; workspaceId: string }) => Promise<Record<string, unknown> | undefined>;
  verify: (observation: TaskObservation) => { passed: boolean; reason: string };
}

function corpusTasks(origin: string, browserEnabled: boolean): CorpusTask[] {
  const tasks: CorpusTask[] = [
    {
      id: "file-read-write-edit",
      marker: "CORPUS_EDIT_OK",
      workspacePath: "corpus-file.txt",
      workspaceExpected: "CORPUS_EDIT_OK",
      allowedTools: ["write_file", "read_file"],
      input: "Create corpus-file.txt with exactly `CORPUS_FILE_INITIAL`. Read it back and verify it. Edit it with write_file so its exact final content is `CORPUS_EDIT_OK`. Read it again and verify the final bytes. Use only write_file and read_file.",
      verify: (o) => requireTools(o, ["write_file", "read_file"], "file read/write/edit") && hasEventText(o, "CORPUS_EDIT_OK")
        ? pass("exact file mutation and read-back observed") : fail("file mutation/read-back evidence incomplete"),
    },
    {
      id: "coding-and-tests",
      marker: "CORPUS_SUM_OK",
      allowedTools: ["write_file", "read_file", "shell_exec"],
      input: "Create sum.js containing a tiny executable Node program that prints exactly CORPUS_SUM_OK. Run it with shell_exec using node sum.js, inspect the result, and do not finish until the output contains CORPUS_SUM_OK.",
      verify: (o) => requireTools(o, ["write_file", "shell_exec"], "coding and tests") && hasEventText(o, "CORPUS_SUM_OK")
        ? pass("code was written and executed with the expected test marker") : fail("coding/test marker was not observed"),
    },
    {
      id: "terminal-work",
      marker: "CORPUS_TERMINAL_OK",
      allowedTools: ["shell_exec"],
      input: "Use shell_exec to run a bounded terminal command that prints exactly CORPUS_TERMINAL_OK. Verify the command result before finishing.",
      verify: (o) => requireTools(o, ["shell_exec"], "terminal") && hasEventText(o, "CORPUS_TERMINAL_OK")
        ? pass("terminal output marker observed") : fail("terminal output marker missing"),
    },
    {
      id: "artifact-production",
      marker: "CORPUS_ARTIFACT_OK",
      workspacePath: "corpus-artifact.txt",
      workspaceExpected: "CORPUS_ARTIFACT_OK",
      allowedTools: ["write_file", "artifact_publish"],
      input: "Use write_file to create corpus-artifact.txt with exactly CORPUS_ARTIFACT_OK, then use artifact_publish on that path with mediaType text/plain. Verify both tool results.",
      verify: (o) => requireTools(o, ["write_file", "artifact_publish"], "artifact production") && hasEventText(o, "CORPUS_ARTIFACT_OK") && hasEventType(o, "artifact.created")
        ? pass("workspace bytes and artifact event observed") : fail("artifact production evidence incomplete"),
    },
    {
      id: "memory-retrieval",
      marker: "CORPUS_MEMORY_OK",
      allowedTools: ["memory_add", "memory_search"],
      input: "Call memory_add with the JSON argument key `markdown` set exactly to `CORPUS_MEMORY_OK`. Then call memory_search with the JSON argument key `query` set to `CORPUS_MEMORY_OK` and verify the returned durable entry before finishing.",
      verify: (o) => requireTools(o, ["memory_add", "memory_search"], "memory retrieval") && hasEventText(o, "CORPUS_MEMORY_OK")
        ? pass("durable memory add and search observed") : fail("memory add/search evidence incomplete"),
    },
    {
      id: "context-exact-retrieval",
      allowedTools: ["context_fetch_exact"],
      input: "Use context_fetch_exact with blockId %CONTEXT_BLOCK_ID% and verify that the exact returned text contains %CONTEXT_MARKER%. Do not invent a replacement and use no other tool.",
      verify: (o) => requireTools(o, ["context_fetch_exact"], "context exact retrieval") && hasEventText(o, "CORPUS_CONTEXT_MARKER")
        ? pass("exact context block was fetched") : fail("exact context evidence incomplete"),
    },
    {
      id: "context-compaction",
      allowedTools: ["context_fetch_exact"],
      input: "Fetch the canonical context block with context_fetch_exact using blockId %CONTEXT_BLOCK_ID% three separate times. Verify the exact returned text contains %CONTEXT_MARKER% on every fetch, then report only after all three exact retrievals succeed. Use no other tool.",
      verify: (o) => countToolCalls(o, "context_fetch_exact") >= 3 && hasEventText(o, "CORPUS_CONTEXT_MARKER")
        ? pass("repeated exact context retrievals observed") : fail("repeated exact context retrieval evidence incomplete"),
    },
  ];
  if (browserEnabled) {
    tasks.push(
      {
        id: "web-research",
        marker: "CORPUS_BROWSER_RESEARCH_OK",
        allowedTools: ["browser_open", "browser_action", "browser_close"],
        input: `Perform a bounded web-research fixture lookup using only browser tools. Call browser_open with {}; use the returned sessionId in browser_action navigate to ${origin}/research and then browser_action snapshot; extract the exact page marker CORPUS_BROWSER_RESEARCH_OK; close with browser_close using the same sessionId. Do not answer until every tool call succeeds.`,
        verify: (o) => requireTools(o, ["browser_open", "browser_action", "browser_close"], "web research") && hasEventText(o, "CORPUS_BROWSER_RESEARCH_OK")
          ? pass("web research fixture navigation and extraction observed") : fail("web research evidence incomplete"),
      },
      {
        id: "browser-research-and-extraction",
        marker: "CORPUS_BROWSER_RESEARCH_OK",
        allowedTools: ["browser_open", "browser_action", "browser_close"],
        input: `First call browser_open with an empty JSON object and capture its returned sessionId. Then call browser_action with JSON {"sessionId":"<that id>","command":{"action":"navigate","url":"${origin}/research"}}; call browser_action again with {"sessionId":"<that id>","command":{"action":"snapshot"}}; report the exact marker CORPUS_BROWSER_RESEARCH_OK; finally call browser_close with {"sessionId":"<that id>"}. Do not use any other tool.`,
        verify: (o) => requireTools(o, ["browser_open", "browser_action", "browser_close"], "browser research") && hasEventText(o, "CORPUS_BROWSER_RESEARCH_OK")
          ? pass("browser navigation and extraction marker observed") : fail("browser research marker or lifecycle missing"),
      },
      {
        id: "browser-download",
        allowedTools: ["browser_open", "browser_action", "browser_close"],
        input: `This is a tool-call-only task. Your very first response MUST be a browser_open tool call with the exact JSON argument {}. Do not answer with prose. Capture the returned sessionId exactly. Then make browser_action with {"sessionId":"<that id>","command":{"action":"navigate","url":"${origin}/download"}}. Then make browser_action with {"sessionId":"<that id>","command":{"action":"screenshot"}} and verify its returned JSON contains artifact metadata including artifactId. Finally make browser_close with {"sessionId":"<that id>"}. Do not use any other tool and do not finish until all four browser tool calls have returned successfully.`,
        verify: (o) => requireTools(o, ["browser_open", "browser_action", "browser_close"], "browser download") && hasEventText(o, "artifactId")
          ? pass("browser artifact metadata observed") : fail("browser screenshot artifact metadata missing"),
      },
    );
  }
  tasks.push(
    {
      id: "process-restart",
      marker: "CORPUS_PROCESS_RESTART_OK",
      workspacePath: "process-restart.txt",
      workspaceExpected: "CORPUS_PROCESS_RESTART_OK",
      allowedTools: ["write_file", "read_file"],
      input: "Create process-restart.txt with exact content CORPUS_PROCESS_RESTART_OK using write_file, read it back with read_file, and verify the exact bytes before finishing.",
      afterRun: async ({ client, runId }) => {
        await restartQualificationServices();
        const persisted = await client.getRun(runId);
        return { passed: persisted.status === "SUCCEEDED", managerGatewayRestarted: true, persistedRunStatus: persisted.status };
      },
      verify: (o) => requireTools(o, ["write_file", "read_file"], "process restart") && hasEventText(o, "CORPUS_PROCESS_RESTART_OK")
        ? pass("file mutation completed before service restart") : fail("process restart preparation evidence incomplete"),
    },
    {
      id: "approval-required-action",
      marker: "CORPUS_APPROVED_OK",
      allowedTools: ["shell_exec"],
      input: "Use shell_exec to print exactly CORPUS_APPROVED_OK. This action requires approval; wait for approval and then verify the result before finishing.",
      verify: (o) => requireTools(o, ["shell_exec"], "approval action") && o.approvals.length > 0 && hasEventText(o, "CORPUS_APPROVED_OK")
        ? pass("approval request/resolution and command output observed") : fail("approval or command evidence missing"),
    },
    {
      id: "cancellation",
      allowedTools: ["shell_exec"],
      cancelAfterMs: 3_000,
      input: "Use shell_exec to run a bounded long command: sleep 30. Do not finish until the command is running.",
      verify: (o) => o.run.status === "CANCELLED" || hasEventType(o, "run.cancelled")
        ? pass("run cancellation reached terminal state") : fail(`run ended as ${o.run.status} instead of CANCELLED`),
    },
    {
      id: "failure-and-resume",
      allowedTools: ["shell_exec"],
      input: "Use shell_exec to run `exit 23`, observe and report the failure, then use shell_exec to print exactly CORPUS_RESUME_OK and verify it. Do not hide the first failure.",
      verify: (o) => requireTools(o, ["shell_exec"], "failure and resume") && hasEventText(o, "CORPUS_RESUME_OK") && o.events.some((event) => event.type === "tool.call.completed" && event.payload?.ok === false)
        ? pass("failed command and resumed successful command observed") : fail("failure/resume sequence incomplete"),
    },
    {
      id: "long-running-work",
      marker: "CORPUS_LONG_OK",
      allowedTools: ["shell_exec"],
      timeoutMs: 120_000,
      input: "Use shell_exec to run `sleep 3; printf CORPUS_LONG_OK`, wait for completion, and verify the exact output.",
      verify: (o) => requireTools(o, ["shell_exec"], "long-running work") && hasEventText(o, "CORPUS_LONG_OK")
        ? pass("long-running command completed with exact marker") : fail("long-running marker missing"),
    },
    {
      id: "snapshot-recovery",
      marker: "CORPUS_SNAPSHOT_OK",
      allowedTools: ["write_file", "read_file"],
      input: "Create snapshot-marker.txt with exact content CORPUS_SNAPSHOT_OK using write_file and read it back with read_file. Verify the exact marker before finishing; the evaluator will cold-checkpoint and run you again against the same workspace.",
      beforeRun: async () => {
        if (!qualificationEnvironment) throw new Error("Qualification environment is unavailable");
        qualificationEnvironment.LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT = "true";
        await restartQualificationServices();
      },
      afterRun: async ({ client, workspaceId }) => {
        const second = await client.createRun({
          agent: agentId,
          workspace: workspaceId,
          input: "Use read_file to read snapshot-marker.txt from the restored workspace. Verify the exact content CORPUS_SNAPSHOT_OK and report it. Do not rewrite the file.",
          budget: { maxTurns: 8, maxToolCalls: 12, totalTimeoutMs: 180_000, modelIdleTimeoutMs: 120_000, commandTimeoutMs: 45_000 },
        }, `qualification-snapshot-recovery-restored-${suffix}`);
        const restored = await observeRun(client, second.runId);
        const passed = restored.run.status === "SUCCEEDED" && hasEventType(restored, "workspace.restore.completed") && hasEventText(restored, "CORPUS_SNAPSHOT_OK");
        return {
          passed,
          coldCheckpointRunId: second.runId,
          restoredRunStatus: restored.run.status,
          restoredToolCalls: restored.toolCalls,
          restoredEventTypes: restored.events.map((event) => event.type),
          restoredDiagnostics: observationDiagnostics(restored),
        };
      },
      verify: (o) => requireTools(o, ["write_file", "read_file"], "snapshot recovery") && hasEventText(o, "CORPUS_SNAPSHOT_OK")
        ? pass("snapshot marker was written and read before cold restore") : fail("snapshot preparation evidence incomplete"),
    },
  );
  return tasks.map((task) => ({
    ...task,
    input: task.input.replaceAll("%CONTEXT_BLOCK_ID%", `operator-${createHash("sha256").update(contextText).digest("hex")}`).replaceAll("%CONTEXT_MARKER%", "CORPUS_CONTEXT_MARKER"),
  }));
}

async function observeRun(client: LiteHarnessClient, runId: string, cancelAfterMs?: number): Promise<TaskObservation> {
  const events: RunEvent[] = [];
  const approvals: string[] = [];
  const approved = new Set<string>();
  let streamError: string | undefined;
  const stream = (async () => {
    try {
      for await (const event of client.events(runId)) {
        events.push(event);
        if (event.type === "approval.requested" && typeof event.payload?.approvalId === "string" && !approved.has(event.payload.approvalId)) {
          approved.add(event.payload.approvalId);
          approvals.push(event.payload.approvalId);
          await client.resolveApproval(event.payload.approvalId, true);
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
    }
  })();
  const cancellation = cancelAfterMs === undefined ? undefined : setTimeout(() => { void client.cancelRun(runId).catch(() => undefined); }, cancelAfterMs);
  let run = await client.getRun(runId);
  const deadline = Date.now() + (cancelAfterMs === undefined ? 320_000 : 90_000);
  while (!["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"].includes(run.status) && Date.now() < deadline) {
    await delay(100);
    run = await client.getRun(runId);
  }
  if (cancellation) clearTimeout(cancellation);
  await Promise.race([stream, delay(2_000)]);
  const toolCalls = events.filter((event) => event.type === "tool.call.requested").map((event) => String(event.payload?.name ?? "unknown"));
  return { run, events, toolCalls, approvals, ...(streamError ? { streamError } : {}) };
}

function requireTools(observation: TaskObservation, required: string[], label: string): boolean {
  return required.every((name) => observation.toolCalls.includes(name)) || observation.events.some((event) => event.type === "agent.message.completed" && String(event.payload?.content ?? "").includes(label));
}

function countToolCalls(observation: TaskObservation, name: string): number {
  return observation.toolCalls.filter((tool) => tool === name).length;
}

function hasEventText(observation: TaskObservation, text: string): boolean {
  return observation.events.some((event) => JSON.stringify(event).includes(text));
}

function hasEventType(observation: TaskObservation, type: string): boolean {
  return observation.events.some((event) => event.type === type);
}

function observationDiagnostics(observation: TaskObservation): Record<string, unknown> {
  return {
    toolCalls: observation.events.filter((event) => event.type === "tool.call.requested").map((event) => ({
      name: event.payload?.name,
      arguments: event.payload?.arguments,
    })),
    toolFailures: observation.events.filter((event) => event.type === "tool.call.completed" && event.payload?.ok === false).map((event) => ({
      name: event.payload?.name,
      content: event.payload?.content,
      error: event.payload?.error,
    })),
    assistantMessages: observation.events.filter((event) => event.type === "agent.message.completed").map((event) => String(event.payload?.content ?? "").slice(0, 2_000)),
    terminalEvents: observation.events.filter((event) => ["run.failed", "run.timed_out", "run.orphaned", "run.succeeded", "run.cancelled"].includes(event.type)).map((event) => ({ type: event.type, payload: event.payload })),
    streamError: observation.streamError,
  };
}

function pass(reason: string): { passed: boolean; reason: string } { return { passed: true, reason }; }
function fail(reason: string): { passed: boolean; reason: string } { return { passed: false, reason }; }

function usageSummary(events: RunEvent[]): { inputTokens: number; outputTokens: number; costUsd: number } {
  return events.filter((event) => event.type === "usage.updated").reduce((sum, event) => ({
    inputTokens: sum.inputTokens + numberField(event.payload?.inputTokens),
    outputTokens: sum.outputTokens + numberField(event.payload?.outputTokens),
    costUsd: sum.costUsd + numberField(event.payload?.costUsd),
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

function numberField(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function workspacePath(path: string): string { return path.replaceAll("\\", "/"); }

function inspectWorkspaceFile(workspaceId: string, path: string, image: string, principal: { appId: string; tenantId: string; userId: string }, expected?: string): Record<string, unknown> {
  if (!expected) return { checked: false };
  const volume = dockerWorkspaceVolumeName(workspaceId, { ...principal, scopes: [] });
  try {
    const content = execFileSync("docker", [
      "run", "--pull=never", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--user", "1000:1000", "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32",
      "--mount", `type=volume,src=${volume},dst=/workspace,readonly`, image, "sh", "-c", "set -eu; cat -- \"/workspace/$1\"", "lite-corpus-read", path,
    ], { encoding: "utf8", windowsHide: true }).trimEnd();
    return { checked: true, contentVerified: content === expected, bytes: Buffer.byteLength(content) };
  } catch (error) {
    return { checked: true, contentVerified: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function createMetricsSampler(installation: string): { start(): void; stop(): void; report(): Record<string, unknown> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let samples = 0;
  let peakContainers = 0;
  let peakRss = 0;
  let peakManaged = 0;
  const sample = () => {
    samples += 1;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const count = managedContainers(installation).length;
    peakContainers = Math.max(peakContainers, count);
    peakManaged = Math.max(peakManaged, count);
  };
  return {
    start: () => { sample(); timer = setInterval(sample, 250); timer.unref?.(); },
    stop: () => { if (timer) clearInterval(timer); sample(); },
    report: () => ({ samples, peakEvaluatorRssBytes: peakRss, peakManagedDockerContainers: peakContainers, peakContainerCount: peakManaged }),
  };
}

async function startBrowserFixture(): Promise<number> {
  browserServer = createServer((request, response) => {
    if (request.url === "/research") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><main><h1>Research Fixture</h1><p>CORPUS_BROWSER_RESEARCH_OK</p></main>");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=corpus.txt" });
    response.end("CORPUS_BROWSER_DOWNLOAD_OK");
  });
  await new Promise<void>((resolveListen, reject) => { browserServer?.once("error", reject).listen(0, "0.0.0.0", resolveListen); });
  const address = browserServer.address();
  if (!address || typeof address === "string") throw new Error("Browser fixture did not expose a TCP port");
  return address.port;
}

async function waitForReady(processes: ChildProcessWithoutNullStreams[], port: number): Promise<number> {
  const deadline = Date.now() + 45_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    const exited = processes.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (exited) throw new Error(`Qualification process exited before readiness: ${managerLogs}\n${gatewayLogs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json() as { ok?: boolean }).ok === true) return port;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(100);
  }
  throw new Error(`Qualification Gateway did not become ready: ${lastError}`);
}

function startProcess(name: string, entry: string, environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (!existsSync(entry)) throw new Error(`${name} entry does not exist: ${entry}`);
  return spawn(process.execPath, ["--import", "tsx", entry], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

function attachLogs(child: ChildProcessWithoutNullStreams, name: "manager" | "gateway"): void {
  const capture = (chunk: Buffer) => {
    if (name === "manager") managerLogs = `${managerLogs}${chunk.toString()}`.slice(-32 * 1024);
    else gatewayLogs = `${gatewayLogs}${chunk.toString()}`.slice(-32 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
}

function stopProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === "win32" && child.pid) {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* process may already be gone */ }
    return Promise.resolve();
  }
  child.kill("SIGTERM");
  return new Promise((resolveStop) => { child.once("close", () => resolveStop()); setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 10_000).unref(); });
}

async function restartQualificationServices(): Promise<void> {
  if (!qualificationEnvironment || qualificationGatewayPort === undefined) throw new Error("Qualification services are not initialized");
  await stopProcess(gateway);
  await stopProcess(manager);
  await delay(750);
  manager = startProcess("manager", join(root, "apps", "manager", "src", "main.ts"), qualificationEnvironment);
  attachLogs(manager, "manager");
  gateway = startProcess("gateway", join(root, "apps", "gateway", "src", "main.ts"), qualificationEnvironment);
  attachLogs(gateway, "gateway");
  await waitForReady([manager, gateway], qualificationGatewayPort);
}

function managedContainers(installation: string): string[] {
  try {
    return execFileSync("docker", ["ps", "--all", "--filter", "label=lite-harness.managed=true", "--filter", `label=lite-harness.installation=${labelDigest(installation)}`, "--format", "{{.ID}}"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch { return []; }
}

function removeManagedContainers(installation: string): void {
  const ids = managedContainers(installation);
  if (ids.length) { try { execFileSync("docker", ["rm", "--force", ...ids], { stdio: "ignore", windowsHide: true }); } catch { /* cleanup is checked below */ } }
}

function managedNetworks(installation: string): string[] {
  try {
    return execFileSync("docker", ["network", "ls", "--filter", "label=lite-harness.managed=true", "--filter", `label=lite-harness.installation=${labelDigest(installation)}`, "--format", "{{.ID}}"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch { return []; }
}

function removeManagedNetworks(installation: string): void {
  const ids = managedNetworks(installation);
  if (ids.length) { try { execFileSync("docker", ["network", "rm", ...ids], { stdio: "ignore", windowsHide: true }); } catch { /* cleanup is checked below */ } }
}

function managedWorkspaceVolumes(workspaceIds: readonly string[], principal: { appId: string; tenantId: string; userId: string }): string[] {
  return workspaceIds.map((workspaceId) => dockerWorkspaceVolumeName(workspaceId, { ...principal, scopes: [] }))
    .filter((volume) => { try { execFileSync("docker", ["volume", "inspect", volume], { stdio: "ignore", windowsHide: true }); return true; } catch { return false; } });
}

function removeManagedVolumes(workspaceIds: readonly string[], principal: { appId: string; tenantId: string; userId: string }): void {
  const volumes = managedWorkspaceVolumes(workspaceIds, principal);
  if (volumes.length) { try { execFileSync("docker", ["volume", "rm", "--force", ...volumes], { stdio: "ignore", windowsHide: true }); } catch { /* cleanup is checked below */ } }
}

function labelDigest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }

function immutableImage(configured: string | undefined, fallback: string): string {
  const value = configured?.trim() || fallback;
  const id = /^sha256:[a-f0-9]{64}$/i.test(value) ? value : execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", value], { encoding: "utf8", windowsHide: true }).trim();
  if (!/^sha256:[a-f0-9]{64}$/i.test(id)) throw new Error(`Image is not pinned: ${id}`);
  return id;
}

function gitOutput(args: string[]): string { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim(); } catch { return "unknown"; } }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
async function closeServer(server: ReturnType<typeof createServer>): Promise<void> { await new Promise<void>((resolveClose) => server.close(() => resolveClose())); }
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject).listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a gateway port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
