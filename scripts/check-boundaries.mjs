import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoots = [resolve(root, "packages"), resolve(root, "apps")];
const files = sourceRoots.flatMap(walk).filter((path) => path.endsWith(".ts"));
const manifests = sourceRoots.flatMap(walk).filter((path) => path.endsWith("package.json"));
const violations = [];

const rules = [
  {
    prefix: "packages/contracts/",
    allowed: new Set(),
    reason: "contracts must not depend on another Lite package",
  },
  {
    prefix: "packages/domain/",
    allowed: new Set(["@lite-harness/contracts"]),
    reason: "domain may depend only on contracts",
  },
  {
    prefix: "packages/agent-runtime/",
    allowed: new Set([
      "@lite-harness/contracts",
      "@lite-harness/domain",
      "@lite-harness/provider-core",
      "@lite-harness/runtime",
    ]),
    reason: "agent runtime cannot own storage, Docker, HTTP, or concrete providers",
  },
  {
    prefix: "packages/control-plane/",
    allowed: new Set([
      "@lite-harness/agent-runtime",
      "@lite-harness/contracts",
      "@lite-harness/domain",
    ]),
    reason: "control plane services must depend on ports, not storage or Docker adapters",
  },
  {
    prefix: "apps/gateway/",
    allowed: new Set([
      "@lite-harness/auth",
      "@lite-harness/auth-sqlite",
      "@lite-harness/config",
      "@lite-harness/contracts",
      "@lite-harness/observability",
    ]),
    reason: "Gateway may own its dedicated auth adapter but cannot import Manager internals, Docker, or general storage",
  },
];

for (const file of files) {
  const localPath = relative(root, file).replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");
  const imports = [...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map(
    (match) => match[1],
  );

  for (const specifier of imports) {
    if (/legacy[\\/]openclaw/i.test(specifier)) {
      violations.push(`${localPath}: production code imports the legacy OpenClaw tree: ${specifier}`);
    }
    if (specifier === "@lite-harness/migration-openclaw" && localPath !== "apps/cli/src/main.ts") {
      violations.push(`${localPath}: OpenClaw migration code is confined to the CLI adapter`);
    }
    if (localPath.startsWith("packages/") && specifier.startsWith("../../apps/")) {
        violations.push(`${localPath}: package imports a composition root or legacy path: ${specifier}`);
    }
  }

  const rule = rules.find((candidate) => localPath.startsWith(candidate.prefix));
  if (!rule) continue;
  for (const specifier of imports.filter((value) => value.startsWith("@lite-harness/"))) {
    if (!rule.allowed.has(specifier)) {
      violations.push(`${localPath}: ${rule.reason}; found ${specifier}`);
    }
  }
}

for (const file of manifests) {
  const localPath = relative(root, file).replaceAll("\\", "/");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };
  for (const dependency of Object.keys(dependencies)) {
    if (/legacy[\\/]openclaw/i.test(dependency)) {
      violations.push(`${localPath}: production manifest depends on the legacy OpenClaw tree: ${dependency}`);
    }
    if (dependency === "@lite-harness/migration-openclaw" && localPath !== "apps/cli/package.json") {
      violations.push(`${localPath}: only the CLI adapter may depend on OpenClaw migration code`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Dependency boundary violations:\n${violations.map((v) => `- ${v}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Dependency boundaries passed for ${files.length} TypeScript files.\n`);
}

function walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return statSync(path).isFile() ? [path] : [];
  });
}
