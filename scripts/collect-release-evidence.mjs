import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { relative, resolve } from "node:path";
import { captureFacts, createEvidenceDocument, writeEvidenceFile } from "./evidence-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  args.set(key.slice(2), process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[++index] ?? "true");
}
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const commit = args.get("commit") ?? head;
const dirty = commit === head ? git("status", "--porcelain=v1").length > 0 : true;
const output = resolve(root, args.get("output") ?? `evidence/runs/${commit}/${os.platform()}-${os.arch()}.json`);
const packagePaths = splitArg("packages", "package.json,pnpm-lock.yaml");
const packages = packagePaths.map((path) => ({ name: path, sha256: hashGitFile(commit, path) }));
const images = splitArg("images").map((entry) => {
  const separator = entry.indexOf("=");
  if (separator < 1) throw new Error("--images entries must use name=sha256:<digest>");
  return { name: entry.slice(0, separator), sha256: entry.slice(separator + 1) };
});
const resultInput = args.get("result") ?? "blocked";
if (!new Set(["blocked", "not-run"]).has(resultInput)) {
  throw new Error("evidence:collect is measurement-only and cannot manufacture pass/fail qualification; use an executable producer or aggregate:evidence");
}
const result = "blocked";
if (args.get("kind") && args.get("kind") !== "measurement") throw new Error("evidence:collect only emits measurement envelopes");
const total = integerArg("tests");
const failed = integerArg("failures");
const skipped = integerArg("skips");
const todo = integerArg("todo");
const passed = args.has("passed") ? integerArg("passed") : total - failed - skipped - todo;
if (passed < 0) throw new Error("test counts exceed --tests");

const facts = captureFacts(root);
facts.commit = commit;
facts.tree = git("rev-parse", `${commit}^{tree}`);
facts.dirty = dirty;
facts.at = args.get("captured-at") ?? facts.at;
const suite = args.get("suite") ?? "release-candidate-aggregate";
const evidence = createEvidenceDocument({
  root,
  kind: "measurement",
  suite,
  command: args.get("command") ?? "pnpm evidence:collect",
  result,
  counts: { total, passed, failed, skipped, todo },
  durationMs: numberArg("duration-ms"),
  requirementIds: splitArg("requirements"),
  regressionIds: splitArg("regressions"),
  claims: { qualification: "measurement-only" },
  packages,
  images,
  facts,
});
if (args.get("id")) evidence.evidenceId = args.get("id");
writeEvidenceFile(output, evidence);
process.stdout.write(`Wrote release evidence ${relative(root, output)} (${result}, ${total} tests, ${skipped} skips).\n`);

function hashGitFile(revision, path) {
  const bytes = execFileSync("git", ["show", `${revision}:${path}`], { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return createHash("sha256").update(bytes).digest("hex");
}

function splitArg(name, fallback = "") {
  return (args.get(name) ?? fallback).split(",").map((value) => value.trim()).filter(Boolean);
}

function integerArg(name) {
  const value = Number.parseInt(args.get(name) ?? "0", 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a nonnegative safe integer`);
  return value;
}

function numberArg(name) {
  const value = Number(args.get(name) ?? 0);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a nonnegative finite number`);
  return value;
}
