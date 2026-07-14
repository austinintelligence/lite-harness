import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("Run the SBOM generator through `pnpm generate:sbom`");
const projects = JSON.parse(execFileSync(process.execPath, [pnpmEntrypoint, "list", "-r", "--json", "--depth", "Infinity"], {
  cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
}));
const components = new Map();
for (const project of projects) {
  add({ name: project.name, version: project.version ?? "0.0.0", type: "library", license: project.private ? undefined : project.license });
  visit(project.dependencies); visit(project.devDependencies); visit(project.optionalDependencies);
}
const lock = readFileSync(resolve(root, "pnpm-lock.yaml"));
const digest = createHash("sha256").update(lock).digest("hex");
const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
const bom = {
  bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: `urn:uuid:${uuid}`, version: 1,
  metadata: { component: { type: "application", name: "lite-harness", version: "0.1.0-alpha.0", "bom-ref": "lite-harness@0.1.0-alpha.0" } },
  components: [...components.values()].sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"])),
};
writeFileSync(resolve(root, "docs", "sbom.cdx.json"), `${JSON.stringify(bom, null, 2)}\n`);
process.stdout.write(`Generated CycloneDX SBOM with ${bom.components.length} components.\n`);

function visit(dependencies) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    add({ name, version: dependency.version ?? "unknown", type: "library" });
    visit(dependency.dependencies); visit(dependency.optionalDependencies);
  }
}

function add({ name, version, type, license }) {
  if (!name) return;
  const ref = `${name}@${version}`;
  if (components.has(ref)) return;
  components.set(ref, {
    type, name, version, "bom-ref": ref,
    purl: `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${encodeURIComponent(version)}`,
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
  });
}
