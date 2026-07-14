import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const gitNames = (args) => execFileSync("git", args, {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}).split("\0").filter(Boolean);
const files = [...new Set([
  ...gitNames(["diff", "--name-only", "--diff-filter=ACMR", "-z"]),
  ...gitNames(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]),
  ...gitNames(["ls-files", "--others", "--exclude-standard", "-z"]),
])];
const forbiddenNames = /(^|\/)(?:\.env(?!\.example$)|auth\.json|credentials\.json)$/i;
const textExtensions = new Set([
  "", ".cjs", ".css", ".env", ".example", ".html", ".js", ".json", ".jsx",
  ".md", ".mjs", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
];
const violations = [];

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (forbiddenNames.test(normalized)) {
    violations.push(`${normalized}: forbidden credential-bearing filename`);
    continue;
  }
  if (!textExtensions.has(extname(normalized).toLowerCase()) || normalized === "pnpm-lock.yaml") {
    continue;
  }
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [label, pattern] of patterns) {
    if (pattern.test(content)) {
      violations.push(`${normalized}: possible ${label}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Secret exposure checks failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret exposure checks passed for ${files.length} repository files.\n`);
}
