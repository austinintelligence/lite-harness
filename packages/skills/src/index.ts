import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface SkillSource {
  root: string;
  precedence: number;
  source: "app" | "user" | "builtin" | "openclaw-import";
}

export interface SkillSnapshot {
  name: string;
  description: string;
  body: string;
  path: string;
  source: SkillSource["source"];
  precedence: number;
  requestedTools: readonly string[];
}

export function discoverSkills(
  sources: readonly SkillSource[],
  options: { maxBytes?: number; maxDepth?: number } = {},
): SkillSnapshot[] {
  const candidates = sources
    .flatMap((source) => discoverSource(source, options.maxDepth ?? 4))
    .sort((left, right) => right.source.precedence - left.source.precedence || left.path.localeCompare(right.path));
  const selected = new Map<string, SkillSnapshot>();
  for (const candidate of candidates) {
    const parsed = parseSkill(candidate.path, candidate.source, options.maxBytes ?? 256 * 1024);
    if (!selected.has(parsed.name)) selected.set(parsed.name, Object.freeze(parsed));
  }
  return [...selected.values()];
}

function discoverSource(source: SkillSource, maxDepth: number): Array<{ path: string; source: SkillSource }> {
  const root = realpathSync(source.root);
  const results: Array<{ path: string; source: SkillSource }> = [];
  const visit = (directory: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = resolve(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) continue;
      if (!isWithin(root, candidate)) throw new Error("Skill discovery escaped its configured root");
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") results.push({ path: candidate, source });
    }
  };
  visit(root, 0);
  return results;
}

function parseSkill(path: string, source: SkillSource, maxBytes: number): SkillSnapshot {
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new Error(`Skill exceeds ${maxBytes} bytes: ${path}`);
  const text = bytes.toString("utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Skill frontmatter is missing or malformed: ${path}`);
  const metadata = Object.fromEntries(
    (match[1] ?? "").split(/\r?\n/).map((line) => {
      const separator = line.indexOf(":");
      return separator < 0 ? [line.trim(), ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
  );
  if (!metadata.name || !metadata.description) throw new Error(`Skill name and description are required: ${path}`);
  return {
    name: metadata.name,
    description: metadata.description,
    body: match[2] ?? "",
    path,
    source: source.source,
    precedence: source.precedence,
    requestedTools: Object.freeze((metadata.tools ?? "").split(",").map((item) => item.trim()).filter(Boolean)),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
