import { mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DockerBrowserDriver,
  DurableBrowserSessionStore,
  EncryptedBrowserProfileStore,
  ManagedBrowserBroker,
  reconcileBrowserResources,
  type BrowserAction,
  type BrowserOwner,
} from "@lite-harness/browser";
import type { InternalPrincipal } from "@lite-harness/contracts";
import type { BrokeredToolRuntime, ToolExecutionContext } from "@lite-harness/runtime";
import type { LocalArtifactStore } from "@lite-harness/workspace";

export interface ManagerBrowserCapabilityOptions {
  runtime: BrokeredToolRuntime;
  artifacts: LocalArtifactStore;
  dataDir: string;
  image: string;
  allowedOrigins?: readonly string[];
  allowPrivateNetworks: boolean;
  idleTtlMs: number;
  remoteCdpEndpoint?: string;
  profileId?: string;
  profileKey?: Buffer;
  driverTimeoutMs?: number;
}

export interface ManagerBrowserCapability {
  readonly activeCount: number;
  stop(): Promise<void>;
}

/** Owns the Manager-facing browser tools and their authorization/artifact boundary. */
export async function configureManagerBrowserCapability(
  options: ManagerBrowserCapabilityOptions,
): Promise<ManagerBrowserCapability> {
  if (Boolean(options.profileId) !== Boolean(options.profileKey)) {
    throw new Error("Browser profile id and encryption key must be configured together");
  }
  const reaped = await reconcileBrowserResources({ installationId: options.dataDir });
  if (reaped.containers || reaped.networks) {
    process.stderr.write(`lite-harness manager: reaped ${reaped.containers} browser container(s) and ${reaped.networks} network(s)\n`);
  }
  const quarantineRoot = join(options.dataDir, "browser-quarantine");
  rmSync(quarantineRoot, { recursive: true, force: true });
  mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  const durability = new DurableBrowserSessionStore(join(options.dataDir, "browser.sqlite"));
  const interrupted = durability.reconcileInterrupted();
  if (interrupted > 0) {
    process.stderr.write(`lite-harness manager: reconciled ${interrupted} interrupted browser session(s)\n`);
  }
  const browser = new ManagedBrowserBroker(() => new DockerBrowserDriver({
    image: options.image,
    quarantineRoot,
    installationId: options.dataDir,
    ...(options.remoteCdpEndpoint ? { remoteCdpEndpoint: options.remoteCdpEndpoint } : {}),
    ...(options.driverTimeoutMs ? { timeoutMs: options.driverTimeoutMs } : {}),
  }), {
    idleTtlMs: options.idleTtlMs,
    durabilityStore: durability,
    ...(options.profileId && options.profileKey
      ? { profileStore: new EncryptedBrowserProfileStore(join(options.dataDir, "browser-profiles"), options.profileKey) }
      : {}),
  });
  const disposers: Array<() => void> = [];
  try {
    disposers.push(options.runtime.register("browser_open", async (params) => {
      const principal = requireBrowserPrincipal(params);
      const owner: BrowserOwner = { ...principal, runId: params.runId as string };
      const sessionId = browser.create(owner, {
        ...(options.allowedOrigins?.length ? { allowedOrigins: [...options.allowedOrigins] } : {}),
        allowPrivateNetworks: options.allowPrivateNetworks,
      }, options.profileId);
      return { callId: params.call.id, ok: true, content: JSON.stringify({ sessionId }), metadata: { sessionId } };
    }));
    disposers.push(options.runtime.register("browser_action", async (params) => {
      const principal = requireBrowserPrincipal(params);
      const sessionId = boundedBrowserString(params.call.arguments.sessionId, "sessionId");
      let action = validateBrowserAction(params.call.arguments.command);
      const owner: BrowserOwner = { ...principal, runId: params.runId as string };
      let uploadArtifactId: string | undefined;
      if (action.action === "upload") {
        uploadArtifactId = boundedBrowserString(action.artifactId, "browser upload artifactId");
        const source = options.artifacts.describe(uploadArtifactId, principal);
        if (!source || source.workspaceId !== params.workspaceId) {
          throw new Error("Browser upload artifact is unavailable in this workspace");
        }
        const quarantineId = await browser.prepareUpload(sessionId, owner, basename(source.path), async (path) => {
          await options.artifacts.materializeToFile(uploadArtifactId as string, principal, path);
        });
        action = { action: "upload", ref: action.ref, name: basename(source.path), quarantineId };
      }
      const result = await browser.execute(sessionId, owner, action, params.signal);
      if (uploadArtifactId) browser.recordArtifact(sessionId, owner, uploadArtifactId, "UPLOAD");
      if (!result.artifact) {
        return { callId: params.call.id, ok: true, content: JSON.stringify(result) };
      }
      const { localPath } = result.artifact;
      if (!localPath) throw new Error("Browser artifact did not cross the quarantine boundary");
      let record: Awaited<ReturnType<LocalArtifactStore["publishFromFile"]>> | undefined;
      try {
        record = await options.artifacts.publishFromFile({
          runId: params.runId as string,
          workspaceId: params.workspaceId,
          principal,
          path: `browser/${result.artifact.name}`,
          mediaType: result.artifact.mediaType,
          sourcePath: localPath,
        });
      } finally {
        browser.releaseArtifact(sessionId, owner, localPath);
      }
      browser.recordArtifact(sessionId, owner, record.id, "DOWNLOAD");
      return {
        callId: params.call.id,
        ok: true,
        content: JSON.stringify({ ...result, artifact: { ...record } }),
        metadata: { artifactId: record.id },
      };
    }));
    disposers.push(options.runtime.register("browser_close", async (params) => {
      const principal = requireBrowserPrincipal(params);
      const sessionId = boundedBrowserString(params.call.arguments.sessionId, "sessionId");
      await browser.close(sessionId, { ...principal, runId: params.runId as string });
      return { callId: params.call.id, ok: true, content: JSON.stringify({ sessionId, closed: true }) };
    }));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    await browser.closeAll().catch(() => undefined);
    durability.close();
    throw error;
  }
  let stopped = false;
  return {
    get activeCount() { return browser.activeCount; },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const dispose of disposers.reverse()) dispose();
      try { await browser.closeAll(); }
      finally { durability.close(); }
    },
  };
}

function requireBrowserPrincipal(params: ToolExecutionContext): InternalPrincipal {
  if (!params.runId || !params.principal) throw new Error("Brokered tool requires an owned run context");
  return params.principal;
}

function boundedBrowserString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000_000) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function validateBrowserAction(value: unknown): BrowserAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser command must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "navigate", "snapshot", "click", "type", "select", "hover", "keyboard", "wait", "screenshot", "pdf", "upload",
    "scroll", "drag", "tabs", "new_tab", "switch_tab", "close_tab", "inspect", "back", "forward", "reload",
  ]);
  if (typeof record.action !== "string" || !allowed.has(record.action)) throw new Error("Browser action is invalid");
  return record as unknown as BrowserAction;
}
