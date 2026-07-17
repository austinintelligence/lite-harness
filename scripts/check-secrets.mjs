import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname } from "node:path";

const gitNames = (args) => execFileSync("git", args, {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}).split("\0").filter(Boolean);
const explicitInputs = [];
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--include") continue;
  const value = process.argv[++index];
  if (!value || value.startsWith("--")) throw new Error("--include requires a file or directory path");
  explicitInputs.push(value);
}
const explicitFiles = new Set(explicitInputs.flatMap(walkFiles).map(normalizedPath));
const files = [...new Set([
  ...gitNames(["ls-files", "-z"]),
  ...gitNames(["diff", "--name-only", "--diff-filter=ACMR", "-z"]),
  ...gitNames(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]),
  ...gitNames(["ls-files", "--others", "--exclude-standard", "-z"]),
  ...explicitFiles,
])];
const forbiddenNames = /(^|\/)(?:\.env(?!\.example$)|auth\.json|credentials\.json)$/i;
const textExtensions = new Set([
  "", ".cjs", ".css", ".env", ".example", ".html", ".js", ".json", ".jsx",
  ".md", ".mjs", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9_-]{20,}\b/],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["Anthropic-style key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
];
const evidencePatterns = [
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}\b/i],
  ["unredacted stack trace", /(?:^|\n)\s*at\s+(?:async\s+)?(?:[^\n(]+\s+\()?[^)\n]+:\d+:\d+\)?/m],
];
const violations = [];

for (const file of files) {
  const normalized = normalizedPath(file);
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
  if (process.argv.includes("--evidence") && explicitFiles.has(normalized)) {
    const evidenceContent = content.replaceAll("\\\\", "\\");
    for (const [label, pattern] of evidencePatterns) {
      if (pattern.test(evidenceContent)) violations.push(`${normalized}: possible ${label}`);
    }
    const values = parseEvidenceStrings(content);
    if (values.some((value) => /(?:file:\/{3})?[A-Za-z]:[\\/]/i.test(value))) {
      violations.push(`${normalized}: possible drive-absolute filesystem path`);
    }
    if (values.some((value) => /\\\\(?:[?.]\\)?[^\\/\s]+[\\/]/.test(value))) {
      violations.push(`${normalized}: possible UNC or device filesystem path`);
    }
    if (values.some(containsUnixAbsolutePath)) violations.push(`${normalized}: possible Unix-absolute filesystem path`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Secret exposure checks failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret exposure checks passed for ${files.length} repository files.\n`);
}

function walkFiles(path) {
  if (!existsSync(path)) throw new Error(`Included secret-scan path does not exist: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return [];
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => walkFiles(`${path}/${name}`));
}

function normalizedPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseEvidenceStrings(content) {
  try {
    return stringValues(JSON.parse(content));
  } catch {
    return [content.replaceAll("\\\\", "\\")];
  }
}

function stringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

function containsUnixAbsolutePath(value) {
  const withoutNetworkUrls = value.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "");
  return /(?:^|[^A-Za-z0-9_\/.])\/(?!\/)(?!\.\.?(?:[\\/]|$))[A-Za-z0-9_-][A-Za-z0-9._~-]*(?:[\\/][^\s"'<>]*)?/.test(withoutNetworkUrls);
}
