import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export interface OpenClawMigrationReport {
  root: string;
  configuration: Array<{ path: string; keys: string[] }>;
  skills: Array<{ name: string; path: string }>;
  pluginCandidates: Array<{ name: string; path: string }>;
  warnings: string[];
}

export function inspectOpenClawRoot(inputRoot: string, maxFiles = 10_000): OpenClawMigrationReport {
  const root = realpathSync(inputRoot);
  const report: OpenClawMigrationReport = { root, configuration: [], skills: [], pluginCandidates: [], warnings: [] };
  let files = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > 6) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name); const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) { report.warnings.push(`Skipped symbolic link: ${relative(root, path)}`); continue; }
      if (metadata.isDirectory()) { visit(path, depth + 1); continue; }
      if (!metadata.isFile() || ++files > maxFiles) throw new Error("OpenClaw migration scan exceeds its file limit");
      if (entry.name === "SKILL.md") report.skills.push({ name: basename(dirname(path)), path });
      if (["openclaw.json", "config.json"].includes(entry.name) && depth <= 3) {
        try {
          const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
          report.configuration.push({ path, keys: value && typeof value === "object" ? Object.keys(value).sort() : [] });
        } catch { report.warnings.push(`Skipped malformed configuration: ${relative(root, path)}`); }
      }
      if (entry.name === "package.json" && /(?:plugin|extension)/i.test(relative(root, directory))) {
        try {
          const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
          report.pluginCandidates.push({ name: typeof value.name === "string" ? value.name : basename(directory), path: directory });
        } catch { report.warnings.push(`Skipped malformed plugin package: ${relative(root, path)}`); }
      }
    }
  };
  visit(root, 0);
  report.skills.sort((a, b) => a.name.localeCompare(b.name));
  report.pluginCandidates.sort((a, b) => a.name.localeCompare(b.name));
  return report;
}

export function importOpenClawSkills(report: OpenClawMigrationReport, dataDir: string): string[] {
  const reportRoot = realpathSync(report.root);
  const destinationRoot = resolve(dataDir, "imports", "openclaw", "skills");
  const imported: string[] = [];
  const names = new Set<string>();
  for (const skill of report.skills) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(skill.name)) throw new Error(`OpenClaw skill name is invalid: ${skill.name}`);
    if (names.has(skill.name)) throw new Error(`OpenClaw skill name is duplicated: ${skill.name}`);
    names.add(skill.name);
    const skillPath = realpathSync(skill.path);
    if (!within(reportRoot, skillPath)) throw new Error("OpenClaw skill source escaped the inspected root");
    const sourceRoot = realpathSync(dirname(skill.path));
    const destination = resolve(destinationRoot, skill.name);
    if (!within(destinationRoot, destination)) throw new Error("OpenClaw skill destination escaped the import root");
    copyTree(sourceRoot, destination, 0);
    imported.push(destination);
  }
  return imported;
}

function copyTree(source: string, destination: string, depth: number): void {
  if (depth > 4) throw new Error("OpenClaw skill exceeds import depth");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name); const to = resolve(destination, entry.name); const metadata = lstatSync(from);
    if (metadata.isSymbolicLink()) throw new Error("OpenClaw skill imports may not contain symbolic links");
    if (entry.isDirectory()) copyTree(from, to, depth + 1);
    else if (entry.isFile()) {
      if (metadata.size > 1024 * 1024) throw new Error("OpenClaw skill file exceeds import limit");
      mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to);
    }
  }
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
