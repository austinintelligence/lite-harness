import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  chmodSync,
  lstatSync,
  fstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SkillSourceKind = "run-pinned" | "workspace" | "app" | "user" | "installed-pack" | "builtin" | "openclaw-import";

export interface SkillSource {
  root: string;
  precedence: number;
  source: SkillSourceKind;
  sourceVersion?: string;
  visibilityScope?: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  contentDigest: string;
  source: SkillSourceKind;
  sourceVersion: string;
  visibilityScope: string;
  precedence: number;
  relativePath: string;
  requestedTools: readonly string[];
  requiredCapabilities: readonly string[];
  compatibleProtocol: string;
  contentProvenance: string;
  executableProvenance: string;
  permissionRequests: readonly string[];
}

export interface ImmutableSkillSnapshot extends SkillCatalogEntry {
  body: string;
  generation: string;
}

/** @deprecated Prefer ImmutableSkillCatalog so bodies stay lazy. */
export interface SkillSnapshot extends ImmutableSkillSnapshot {
  path: string;
}

export interface SkillEligibility {
  allowedTools?: ReadonlySet<string>;
  capabilities?: ReadonlySet<string>;
  protocolVersion?: string;
  visibilityScopes?: ReadonlySet<string>;
}

export class ImmutableSkillCatalog {
  readonly generation: string;
  readonly #entries: readonly InternalSkillEntry[];
  readonly #byName: ReadonlyMap<string, InternalSkillEntry>;
  readonly #maxPromptCharacters: number;

  constructor(
    sources: readonly SkillSource[],
    options: {
      snapshotRoot: string;
      maxBytes?: number;
      maxPromptCharacters?: number;
      maxDepth?: number;
      maxCandidates?: number;
      maxFrontmatterBytes?: number;
      protocolVersion?: string;
    },
  ) {
    const limits = {
      maxBytes: options.maxBytes ?? 256 * 1024,
      maxPromptCharacters: options.maxPromptCharacters ?? 200_000,
      maxDepth: options.maxDepth ?? 4,
      maxCandidates: options.maxCandidates ?? 256,
      maxFrontmatterBytes: options.maxFrontmatterBytes ?? 32 * 1024,
      protocolVersion: options.protocolVersion ?? "1",
    };
    validateLimits({
      maxBytes: limits.maxBytes,
      maxPromptCharacters: limits.maxPromptCharacters,
      maxDepth: limits.maxDepth,
      maxCandidates: limits.maxCandidates,
      maxFrontmatterBytes: limits.maxFrontmatterBytes,
    });
    const candidates = sources.flatMap((source) => discoverSource(source, limits.maxDepth, limits.maxCandidates));
    if (candidates.length > limits.maxCandidates) throw new Error(`Skill catalog exceeds ${limits.maxCandidates} candidates`);
    const manifests = candidates.map((candidate) => scanManifest(candidate.path, candidate.source, limits));
    manifests.sort((left, right) =>
      sourceRank(right.source) - sourceRank(left.source)
      || right.precedence - left.precedence
      || left.relativePath.localeCompare(right.relativePath),
    );
    const selected = new Map<string, ScannedSkill>();
    for (const manifest of manifests) if (!selected.has(manifest.name)) selected.set(manifest.name, manifest);
    const selectedValues = [...selected.values()].sort((left, right) => left.name.localeCompare(right.name));
    this.generation = createHash("sha256").update(JSON.stringify(selectedValues.map(catalogIdentity))).digest("hex");
    const generationRoot = join(resolve(options.snapshotRoot), this.generation);
    mkdirSync(generationRoot, { recursive: true, mode: 0o700 });
    this.#entries = Object.freeze(selectedValues.map((manifest) => {
      const snapshotPath = join(generationRoot, `${manifest.contentDigest}.md`);
      let created = false;
      try {
        writeFileSync(snapshotPath, manifest.sourceBytes, { flag: "wx", mode: 0o400 });
        created = true;
        chmodSync(snapshotPath, 0o400);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (digestFile(snapshotPath, limits.maxBytes) !== manifest.contentDigest) {
        rmSync(snapshotPath, { force: true });
        throw new Error(`Skill changed while immutable snapshot was created: ${manifest.relativePath}`);
      }
      if (!created && (lstatSync(snapshotPath).mode & 0o222) !== 0) {
        throw new Error(`Immutable skill snapshot is writable: ${manifest.relativePath}`);
      }
      return Object.freeze({ ...publicEntry(manifest), snapshotPath, generation: this.generation });
    }));
    this.#byName = new Map(this.#entries.map((entry) => [entry.name, entry]));
    this.#maxPromptCharacters = limits.maxPromptCharacters;
  }

  list(eligibility: SkillEligibility = {}): readonly SkillCatalogEntry[] {
    return Object.freeze(this.#entries.filter((entry) => eligible(entry, eligibility)).map((entry) => Object.freeze(publicEntry(entry))));
  }

  view(name: string, eligibility: SkillEligibility = {}): ImmutableSkillSnapshot | undefined {
    const entry = this.#byName.get(name);
    if (!entry || !eligible(entry, eligibility)) return undefined;
    const bytes = readFileSync(entry.snapshotPath);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.contentDigest) throw new Error(`Immutable skill snapshot failed digest verification: ${name}`);
    const body = parseBody(bytes.toString("utf8"), entry.relativePath);
    if (body.length > this.#maxPromptCharacters) throw new Error(`Skill prompt exceeds ${this.#maxPromptCharacters} characters: ${name}`);
    return Object.freeze({ ...publicEntry(entry), body, generation: this.generation });
  }

  snapshotForRun(runId: string, eligibility: SkillEligibility = {}): Readonly<{ runId: string; generation: string; skills: readonly Readonly<{ name: string; digest: string }>[] }> {
    if (!/^run_[A-Za-z0-9_-]{1,128}$/.test(runId) && !/^[A-Za-z0-9._:-]{1,256}$/.test(runId)) throw new Error("Run id is invalid for a skill snapshot");
    return Object.freeze({
      runId,
      generation: this.generation,
      skills: Object.freeze(this.list(eligibility).map((entry) => Object.freeze({ name: entry.name, digest: entry.contentDigest }))),
    });
  }
}

export interface DurableSkillRunSnapshotRecord {
  runId: string;
  appId: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
  generation: string;
  skills: readonly Readonly<{ name: string; digest: string }>[];
  createdAt: string;
}

export class DurableSkillRunSnapshotStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS skill_run_snapshots (
        run_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        generation TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_run_snapshots_owner_idx
        ON skill_run_snapshots (app_id, tenant_id, user_id, run_id);
    `);
  }

  record(params: {
    runId: string;
    appId: string;
    tenantId: string;
    userId: string;
    workspaceId: string;
    generation: string;
    skills: readonly Readonly<{ name: string; digest: string }>[];
  }): DurableSkillRunSnapshotRecord {
    const canonicalSkills = JSON.stringify(params.skills.map((skill) => ({ name: skill.name, digest: skill.digest })));
    const createdAt = new Date().toISOString();
    const inserted = this.#database.prepare(`
      INSERT OR IGNORE INTO skill_run_snapshots (
        run_id, app_id, tenant_id, user_id, workspace_id, generation, skills_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(params.runId, params.appId, params.tenantId, params.userId, params.workspaceId, params.generation, canonicalSkills, createdAt);
    if (inserted.changes === 0) {
      const existing = this.get(params.runId, { appId: params.appId, tenantId: params.tenantId, userId: params.userId });
      if (!existing || existing.workspaceId !== params.workspaceId || existing.generation !== params.generation || JSON.stringify(existing.skills) !== canonicalSkills) {
        throw new Error(`Immutable skill snapshot changed for run ${params.runId}`);
      }
      return existing;
    }
    return {
      ...params,
      skills: Object.freeze(params.skills.map((skill) => Object.freeze({ ...skill }))),
      createdAt,
    };
  }

  get(runId: string, owner: { appId: string; tenantId: string; userId: string }): DurableSkillRunSnapshotRecord | undefined {
    const row = this.#database.prepare(`
      SELECT run_id, app_id, tenant_id, user_id, workspace_id, generation, skills_json, created_at
      FROM skill_run_snapshots WHERE run_id = ? AND app_id = ? AND tenant_id = ? AND user_id = ?
    `).get(runId, owner.appId, owner.tenantId, owner.userId) as {
      run_id: string; app_id: string; tenant_id: string; user_id: string; workspace_id: string;
      generation: string; skills_json: string; created_at: string;
    } | undefined;
    if (!row) return undefined;
    const skills = JSON.parse(row.skills_json) as Array<{ name: string; digest: string }>;
    if (!Array.isArray(skills) || skills.some((skill) => !skill || typeof skill.name !== "string" || !/^[a-f0-9]{64}$/.test(skill.digest))) {
      throw new Error(`Durable skill snapshot is invalid for run ${runId}`);
    }
    return {
      runId: row.run_id, appId: row.app_id, tenantId: row.tenant_id, userId: row.user_id,
      workspaceId: row.workspace_id, generation: row.generation,
      skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))), createdAt: row.created_at,
    };
  }

  close(): void { this.#database.close(); }
}

export function discoverSkills(
  sources: readonly SkillSource[],
  options: { maxBytes?: number; maxDepth?: number; maxCandidates?: number } = {},
): SkillSnapshot[] {
  const snapshotRoot = join(tmpdir(), `lite-skill-compat-${process.pid}-${randomUUID()}`);
  const catalog = new ImmutableSkillCatalog(sources, { snapshotRoot, ...options });
  return catalog.list().map((entry) => {
    const viewed = catalog.view(entry.name);
    if (!viewed) throw new Error(`Skill disappeared from immutable catalog: ${entry.name}`);
    return { ...viewed, path: join(snapshotRoot, catalog.generation, `${entry.contentDigest}.md`) };
  });
}

interface ScannedSkill extends SkillCatalogEntry { sourceBytes: Buffer }
interface InternalSkillEntry extends SkillCatalogEntry { snapshotPath: string; generation: string }

function discoverSource(source: SkillSource, maxDepth: number, maxCandidates: number): Array<{ path: string; source: SkillSource }> {
  const root = realpathSync(source.root);
  const results: Array<{ path: string; source: SkillSource }> = [];
  const visit = (directory: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = resolve(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) continue;
      if (!isWithin(root, candidate)) throw new Error("Skill discovery escaped its configured root");
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push({ path: candidate, source });
        if (results.length > maxCandidates) throw new Error(`Skill source exceeds ${maxCandidates} candidates: ${source.root}`);
      }
    }
  };
  visit(root, 0);
  return results;
}

function scanManifest(
  path: string,
  source: SkillSource,
  limits: { maxBytes: number; maxFrontmatterBytes: number; protocolVersion: string },
): ScannedSkill {
  const root = realpathSync(source.root);
  if (!isWithin(root, realpathSync(path))) throw new Error("Skill source resolved outside its configured root");
  const sourceFile = readStableRegularFile(path, limits.maxBytes, "Skill");
  if (!isWithin(root, realpathSync(path))) throw new Error("Skill source changed outside its configured root");
  const header = sourceFile.bytes.subarray(0, limits.maxFrontmatterBytes).toString("utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(header);
  if (!match) throw new Error(`Skill frontmatter is missing, malformed, or exceeds ${limits.maxFrontmatterBytes} bytes: ${path}`);
  const metadata = parseFrontmatter(match[1] ?? "", path);
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const name = bounded(metadata.name, "skill name", 128, path);
  const description = bounded(metadata.description, "skill description", 1_024, path);
  return {
    name,
    description,
    contentDigest: sourceFile.digest,
    source: source.source,
    sourceVersion: bounded(metadata.source_version || source.sourceVersion || "unversioned", "skill source version", 128, path),
    visibilityScope: bounded(source.visibilityScope || metadata.visibility || "private", "skill visibility", 128, path),
    precedence: source.precedence,
    relativePath,
    requestedTools: frozenCsv(metadata.tools),
    requiredCapabilities: frozenCsv(metadata.capabilities),
    compatibleProtocol: bounded(metadata.protocol || limits.protocolVersion, "skill protocol", 64, path),
    contentProvenance: bounded(metadata.content_provenance || source.source, "skill content provenance", 256, path),
    executableProvenance: bounded(metadata.executable_provenance || "none", "skill executable provenance", 256, path),
    permissionRequests: frozenCsv(metadata.permissions),
    sourceBytes: sourceFile.bytes,
  };
}

function parseFrontmatter(value: string, path: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Skill frontmatter line is malformed: ${path}`);
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || Object.hasOwn(metadata, key)) throw new Error(`Skill frontmatter key is invalid or duplicated: ${path}`);
    metadata[key] = line.slice(separator + 1).trim();
  }
  if (!metadata.name || !metadata.description) throw new Error(`Skill name and description are required: ${path}`);
  return metadata;
}

function parseBody(text: string, path: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Immutable skill snapshot is malformed: ${path}`);
  return match[1] ?? "";
}

function digestFile(path: string, maxBytes: number): string {
  return readStableRegularFile(path, maxBytes, "Immutable skill snapshot").digest;
}

function readStableRegularFile(path: string, maxBytes: number, label: string): { bytes: Buffer; digest: string } {
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    throw new Error(`${label} is not a stable single-link regular file: ${path}`);
  }
  if (initial.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(initial, opened)) {
    closeSync(descriptor);
    throw new Error(`${label} changed before its immutable read: ${path}`);
  }
  const digest = createHash("sha256");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      total += read;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
      const chunk = Buffer.from(buffer.subarray(0, read));
      chunks.push(chunk);
      digest.update(chunk);
    }
    const completed = fstatSync(descriptor);
    if (!sameStableFileVersion(opened, completed) || completed.nlink !== 1 || total !== completed.size) {
      throw new Error(`${label} changed during its immutable read: ${path}`);
    }
  } finally {
    closeSync(descriptor);
  }
  let current;
  try { current = lstatSync(path); } catch { throw new Error(`${label} path changed during its immutable read: ${path}`); }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameFileIdentity(opened, current) ||
      !sameStableFileVersion(opened, current)) {
    throw new Error(`${label} path changed during its immutable read: ${path}`);
  }
  return { bytes: Buffer.concat(chunks, total), digest: digest.digest("hex") };
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileVersion(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}

function eligible(entry: SkillCatalogEntry, eligibility: SkillEligibility): boolean {
  if (eligibility.visibilityScopes && entry.visibilityScope !== "public" && !eligibility.visibilityScopes.has(entry.visibilityScope)) return false;
  if (eligibility.protocolVersion && entry.compatibleProtocol !== eligibility.protocolVersion) return false;
  if (eligibility.allowedTools && entry.requestedTools.some((tool) => !eligibility.allowedTools?.has(tool))) return false;
  if (eligibility.capabilities && entry.requiredCapabilities.some((capability) => !eligibility.capabilities?.has(capability))) return false;
  return true;
}

function publicEntry(entry: SkillCatalogEntry): SkillCatalogEntry {
  return {
    name: entry.name, description: entry.description, contentDigest: entry.contentDigest,
    source: entry.source, sourceVersion: entry.sourceVersion, visibilityScope: entry.visibilityScope,
    precedence: entry.precedence, relativePath: entry.relativePath,
    requestedTools: Object.freeze([...entry.requestedTools]), requiredCapabilities: Object.freeze([...entry.requiredCapabilities]),
    compatibleProtocol: entry.compatibleProtocol, contentProvenance: entry.contentProvenance,
    executableProvenance: entry.executableProvenance, permissionRequests: Object.freeze([...entry.permissionRequests]),
  };
}

function catalogIdentity(entry: SkillCatalogEntry): unknown {
  return publicEntry(entry);
}

function sourceRank(source: SkillSourceKind): number {
  return ({ "run-pinned": 5, workspace: 4, app: 3, user: 3, "installed-pack": 2, "openclaw-import": 2, builtin: 1 })[source];
}

function frozenCsv(value: string | undefined): readonly string[] {
  const items = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length > 64 || items.some((item) => item.length > 128 || /[\0\r\n]/.test(item))) throw new Error("Skill manifest list is invalid");
  return Object.freeze([...new Set(items)]);
}

function bounded(value: string | undefined, label: string, maximum: number, path: string): string {
  if (!value || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid: ${path}`);
  return value;
}

function validateLimits(limits: { maxBytes: number; maxPromptCharacters: number; maxDepth: number; maxCandidates: number; maxFrontmatterBytes: number }): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) throw new Error(`Skill catalog ${name} limit is invalid`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
