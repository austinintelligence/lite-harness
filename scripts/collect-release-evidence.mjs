import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  args.set(key.slice(2), process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[++index] ?? "true");
}
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const commit = args.get("commit") ?? git("rev-parse", "HEAD");
const dirty = args.has("dirty") ? args.get("dirty") === "true" : git("status", "--porcelain=v1").length > 0;
const output = resolve(root, args.get("output") ?? `evidence/runs/${commit}/${os.platform()}-${os.arch()}.json`);
const docker = dockerFacts();
const packagePaths = (args.get("packages") ?? "package.json,pnpm-lock.yaml").split(",").filter(Boolean);
const packages = packagePaths.map((path) => ({ name: path, sha256: hashGitFile(commit, path) }));
const images = (args.get("images") ?? "").split(",").filter(Boolean).map((entry) => {
  const [name, sha256] = entry.split("=");
  return { name, sha256: sha256?.replace(/^sha256:/, "") };
});
const resultInput = args.get("result") ?? "not-run";
const result = resultInput === "success" ? "pass" : resultInput === "failure" ? "fail" : resultInput;
const evidence = {
  schemaVersion: 1,
  evidenceId: args.get("id") ?? `${args.get("suite") ?? "unspecified"}-${commit.slice(0, 12)}-${os.platform()}-${os.arch()}`,
  commit,
  dirty,
  capturedAt: args.get("captured-at") ?? new Date().toISOString(),
  platform: { os: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length },
  runtime: { node: process.version, pnpm: commandVersion(process.execPath, [process.env.npm_execpath, "--version"].filter(Boolean)), docker },
  artifacts: { packages, images },
  test: {
    suite: args.get("suite") ?? "unspecified",
    result,
    tests: integerArg("tests"),
    failures: integerArg("failures"),
    skips: integerArg("skips"),
    durationMs: numberArg("duration-ms"),
  },
  externalGates: {
    linuxRootful: "missing", linuxRootless: "missing", linuxArm64: "missing",
    macosIntelDockerDesktop: "missing", macosAppleSiliconDockerDesktop: "missing",
    windows11DockerDesktopWsl2: "missing", openaiLive: "missing", anthropicLive: "missing",
    codexLive: "missing", namingApproval: "missing", signingAuthority: "missing", registryPromotion: "missing",
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`Wrote release evidence ${relative(root, output)} (${result}, ${evidence.test.tests} tests, ${evidence.test.skips} skips).\n`);

function hashGitFile(revision, path) {
  const bytes = execFileSync("git", ["show", `${revision}:${path}`], { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return createHash("sha256").update(bytes).digest("hex");
}

function commandVersion(file, commandArgs) {
  try { return execFileSync(file, commandArgs, { cwd: root, encoding: "utf8" }).trim(); }
  catch { return "unavailable"; }
}

function dockerFacts() {
  try {
    const version = JSON.parse(execFileSync("docker", ["version", "--format", "{{json .}}"], { encoding: "utf8" }));
    return {
      available: true,
      context: execFileSync("docker", ["context", "show"], { encoding: "utf8" }).trim(),
      clientVersion: version.Client?.Version ?? null,
      serverVersion: version.Server?.Version ?? null,
      serverOs: version.Server?.Os ?? null,
      serverArchitecture: version.Server?.Arch ?? null,
      platform: version.Server?.Platform?.Name ?? null,
      kernel: version.Server?.KernelVersion ?? null,
    };
  } catch {
    return { available: false, context: null, clientVersion: null, serverVersion: null, serverOs: null, serverArchitecture: null };
  }
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
