import type { ModelRunContext } from "@lite-harness/provider-core";
import type { SqliteRunStore } from "@lite-harness/storage-sqlite";

/** Resolves only the owned registered bind currently fenced to this run. */
export function createDelegatedWorkspaceResolver(
  runStore: SqliteRunStore,
): (context: ModelRunContext) => string {
  return (context) => {
    const run = runStore.getRun(context.runId);
    if (!run || run.appId !== context.principal.appId || run.tenantId !== context.principal.tenantId ||
        run.userId !== context.principal.userId || run.workspaceId !== context.workspaceId) {
      throw new Error("Delegated run workspace ownership is invalid");
    }
    if (!runStore.validateWorkspaceLease({
      workspaceId: context.workspaceId,
      ownerRunId: context.runId,
      fencingToken: context.fencingToken,
      expiresAt: "",
    })) {
      throw new Error("Delegated run workspace lease is invalid or expired");
    }
    const workspace = runStore.getWorkspace(context.workspaceId, context.principal);
    if (!workspace?.registeredPath || workspace.mode !== "registered-bind") {
      throw new Error("Delegated host runtimes require the run's explicitly registered workspace bind");
    }
    return workspace.registeredPath;
  };
}
