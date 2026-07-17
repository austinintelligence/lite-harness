import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryToolRuntime } from "@lite-harness/runtime";
import { DEFAULT_RUN_BUDGET } from "@lite-harness/contracts";
import { dockerWorkspaceVolumeName } from "@lite-harness/runtime-docker";
import { SqliteRunStore } from "@lite-harness/storage-sqlite";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("owner-scoped resource identities", () => {
  it("BD-013-REGRESSION backs shared external slugs with distinct opaque internal IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "lite-owner-identities-"));
    roots.push(root);
    const path = join(root, "identities.db");
    const store = new SqliteRunStore(path);
    const firstOwner = owner("user-one");
    const secondOwner = owner("user-two");

    store.createOrGetRun("run-owner-one", runRequest(firstOwner, "first input"));
    store.createOrGetRun("run-owner-two", runRequest(secondOwner, "second input"));

    expect(store.listAgentProfiles(firstOwner).map((record) => record.id)).toEqual(["shared-agent"]);
    expect(store.listAgentProfiles(secondOwner).map((record) => record.id)).toEqual(["shared-agent"]);
    store.createAgentProfile({
      id: "unused-agent", version: 1, appId: firstOwner.appId, tenantId: firstOwner.tenantId, userId: firstOwner.userId,
      name: "Unused", instructions: "", modelCapabilities: ["text"], allowedTools: [], defaultBudget: DEFAULT_RUN_BUDGET, createdAt: new Date().toISOString(),
    });
    expect(store.deleteAgentProfile("unused-agent", firstOwner)).toBe(true);
    expect(store.getAgentProfile("unused-agent", firstOwner)).toBeUndefined();
    expect(store.getAgentProfile("shared-agent", firstOwner)).toBeDefined();
    expect(store.listWorkspaces(firstOwner).map((record) => record.id)).toEqual(["shared-workspace"]);
    expect(store.listWorkspaces(secondOwner).map((record) => record.id)).toEqual(["shared-workspace"]);
    expect(store.getSession("shared-session", firstOwner)).toMatchObject({ userId: "user-one" });
    expect(store.getSession("shared-session", secondOwner)).toMatchObject({ userId: "user-two" });
    expect(store.listSessionMessages("shared-session", firstOwner)).toMatchObject([{ content: "first input" }]);
    expect(store.listSessionMessages("shared-session", secondOwner)).toMatchObject([{ content: "second input" }]);
    expect(store.listRuns(firstOwner).map((record) => record.id)).toEqual(["run-owner-one"]);
    expect(store.listRuns(secondOwner).map((record) => record.id)).toEqual(["run-owner-two"]);
    expect(store.listRuns(firstOwner, 0).map((record) => record.id)).toEqual(["run-owner-one"]);
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    for (const table of ["agent_profiles", "workspaces", "sessions"]) {
      const rows = database.prepare(`SELECT internal_id, id FROM ${table} ORDER BY internal_id`).all() as Array<{
        internal_id: string;
        id: string;
      }>;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.internal_id)).size).toBe(2);
      expect(rows.every((row) => row.internal_id !== row.id && /^[a-z]{3}_[a-f0-9]{32}$/u.test(row.internal_id))).toBe(true);
    }
    const references = database.prepare(
      "SELECT agent_internal_id, workspace_internal_id, session_internal_id FROM runs ORDER BY id",
    ).all() as Array<Record<string, string>>;
    expect(references).toHaveLength(2);
    expect(references.every((row) => Object.values(row).every(Boolean))).toBe(true);
    expect(references[0]).not.toEqual(references[1]);
    database.close();
  });

  it("isolates in-memory workspace contents for owners sharing a slug", async () => {
    const runtime = new InMemoryToolRuntime();
    const first = owner("user-one");
    const second = owner("user-two");
    await runtime.execute({
      workspaceId: "shared-workspace", principal: first,
      call: { id: "call-write", name: "write_file", arguments: { path: "owner.txt", content: "first" } },
    });
    const result = await runtime.execute({
      workspaceId: "shared-workspace", principal: second,
      call: { id: "call-read", name: "read_file", arguments: { path: "owner.txt" } },
    });
    expect(result).toMatchObject({ ok: false, content: "File not found: owner.txt" });
    expect(dockerWorkspaceVolumeName("shared-workspace", first))
      .not.toBe(dockerWorkspaceVolumeName("shared-workspace", second));
  });
});

function owner(userId: string) {
  return { appId: "shared-app", tenantId: "shared-tenant", userId, scopes: ["runs:create"] };
}

function runRequest(principal: ReturnType<typeof owner>, input: string) {
  return {
    agent: "shared-agent",
    workspace: "shared-workspace",
    session: "shared-session",
    input,
    idempotencyKey: "shared-key",
    principal,
  };
}
