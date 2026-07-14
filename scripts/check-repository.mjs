import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const git = (args, options = {}) => execFileSync("git", args, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  ...options,
});
const splitNull = (value) => value.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
const tracked = splitNull(git(["ls-files", "-z"]));
const failures = [];

const trackedIgnored = splitNull(git(["ls-files", "-ci", "--exclude-standard", "-z"]));
for (const file of trackedIgnored) failures.push(`tracked file is now ignored: ${file}`);

const expectedIgnored = [
  ".env.local",
  ".codex/session.json",
  ".review-artifacts/report.md",
  ".audit/findings.json",
  ".omx/state/session.json",
  ".lite-harness/state.db",
  "node_modules/example.js",
  "coverage/index.html",
  "reports/junit.xml",
  "artifacts/package.tgz",
  "sdks/python/.venv/python",
  "sdks/python/.coverage",
  "playwright-report/index.html",
  "runtime.sqlite-wal",
  "temp/output.tmp",
  "local-signing-key.p12",
];
const ignored = new Set(splitNull(git(["check-ignore", "--no-index", "-z", "--stdin"], {
  input: `${expectedIgnored.join("\0")}\0`,
})));
for (const file of expectedIgnored) {
  if (!ignored.has(file)) failures.push(`.gitignore does not cover ${file}`);
}

for (const file of [".env.example", "SECURITY.md", "evidence/baseline/example.json"]) {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "--quiet", file], { cwd: root });
    failures.push(`.gitignore must keep ${file} trackable`);
  } catch (error) {
    if (error.status !== 1) failures.push(`could not verify that ${file} remains trackable`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Repository hygiene checks failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Repository hygiene checks passed for ${tracked.length} tracked files.\n`);
}
