import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DockerToolRuntime, inspectDocker } from "@lite-harness/runtime-docker";
import { LocalWorkspaceSnapshotStore, StaticSnapshotKeyProvider } from "@lite-harness/workspace";

const [command = "help", subcommand, argument] = process.argv.slice(2);
const dataDir = process.env.LITE_HARNESS_DATA_DIR ?? join(process.cwd(), ".lite-harness");

if (command === "doctor") {
  mkdirSync(dataDir, { recursive: true });
  let dataDirectoryWritable = true;
  try { accessSync(dataDir, constants.R_OK | constants.W_OK); } catch { dataDirectoryWritable = false; }
  const docker = await inspectDocker();
  const report = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 24, version: process.versions.node },
    docker,
    dataDirectory: { ok: dataDirectoryWritable, path: dataDir },
    snapshotKeyConfigured: Boolean(process.env.LITE_HARNESS_SNAPSHOT_KEY),
    providerConfigured: Boolean(process.env.LITE_HARNESS_PROVIDER_API_KEY) || (process.env.LITE_HARNESS_PROVIDER ?? "fake") === "fake",
    platform: { os: process.platform, arch: process.arch },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.node.ok && docker.available && dataDirectoryWritable ? 0 : 1;
} else if (command === "workspace" && ["snapshot", "restore", "delete"].includes(subcommand ?? "")) {
  if (!argument) throw new Error("A workspace id is required");
  const runtime = new DockerToolRuntime({ image: requiredEnvironment("LITE_HARNESS_RUNTIME_IMAGE") });
  if (subcommand === "delete") {
    const removed = await runtime.removeWorkspace(argument);
    process.stdout.write(`${JSON.stringify({ workspaceId: argument, removed })}\n`);
  } else {
    const snapshots = new LocalWorkspaceSnapshotStore(
      join(dataDir, "snapshots"),
      new StaticSnapshotKeyProvider(snapshotKey()),
    );
    if (subcommand === "snapshot") {
      const record = await snapshots.create(argument, await runtime.exportWorkspace(argument));
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      const restored = await snapshots.restore(argument);
      await runtime.importWorkspace(argument, restored.archive);
      process.stdout.write(`${JSON.stringify({ workspaceId: argument, recoveredFromPrevious: restored.recoveredFromPrevious })}\n`);
    }
  }
} else if (command === "keygen") {
  process.stdout.write(`${randomBytes(32).toString("base64")}\n`);
} else {
  process.stdout.write(
    "Lite-Harness\n\nCommands:\n  doctor\n  keygen\n  workspace snapshot <id>\n  workspace restore <id>\n  workspace delete <id>\n",
  );
}

function snapshotKey(): Buffer {
  const value = requiredEnvironment("LITE_HARNESS_SNAPSHOT_KEY");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("LITE_HARNESS_SNAPSHOT_KEY must be a base64-encoded 32-byte key");
  return key;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
