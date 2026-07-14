import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const dist = resolve(root, "dist");
const staging = resolve(root, "artifacts", "packages");
rmSync(dist, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const applications = ["manager", "gateway", "launcher", "cli"];
const applicationRoot = resolve(staging, "application");
for (const name of applications) {
  const outdir = resolve(applicationRoot, "apps", name);
  await bundle(resolve(root, "apps", name, "src", "main.ts"), resolve(outdir, "main.js"), {
    external: ["fastify"],
    ...(name === "cli" ? { banner: { js: "#!/usr/bin/env node" } } : {}),
  });
  if (name === "cli") chmodSync(resolve(outdir, "main.js"), 0o755);
  if (name === "manager" || name === "cli") {
    copyFileSync(resolve(root, "packages", "plugin-core", "src", "openclaw-host.mjs"), resolve(outdir, "openclaw-host.mjs"));
  }
}
cpSync(resolve(applicationRoot, "apps"), resolve(dist, "apps"), { recursive: true });

const contractsRoot = resolve(staging, "contracts");
const sdkRoot = resolve(staging, "sdk");
await bundle(resolve(root, "packages", "contracts", "src", "index.ts"), resolve(contractsRoot, "dist", "index.js"));
await bundle(resolve(root, "packages", "sdk-typescript", "src", "index.ts"), resolve(sdkRoot, "dist", "index.js"));
emitDeclarations("packages/contracts/src/index.ts", resolve(contractsRoot, "dist"));
emitDeclarations("packages/sdk-typescript/src/index.ts", resolve(sdkRoot, "dist"));

writePackage(contractsRoot, {
  name: "@lite-harness/contracts",
  version,
  description: "Versioned Lite-Harness public contracts",
  dependencies: { "@sinclair/typebox": "0.34.41" },
});
writePackage(sdkRoot, {
  name: "@lite-harness/sdk",
  version,
  description: "Node ESM SDK for the Lite-Harness REST and replayable SSE API",
  dependencies: { "@lite-harness/contracts": version },
});
writeApplicationPackage(applicationRoot);

const packageOutput = resolve(dist, "packages");
mkdirSync(packageOutput, { recursive: true });
for (const directory of [applicationRoot, contractsRoot, sdkRoot]) {
  const npm = npmCommand();
  execFileSync(npm.command, [...npm.prefix, "pack", directory, "--pack-destination", packageOutput], {
    cwd: root,
    stdio: "inherit",
  });
}

function npmCommand() {
  return process.platform === "win32"
    ? { command: process.execPath, prefix: [resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] }
    : { command: "npm", prefix: [] };
}
process.stdout.write(`Built ${applications.length} applications and 3 npm packages at ${dist}\n`);

async function bundle(entry, outfile, options = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
    legalComments: "external",
    ...(options.external ? { external: options.external } : {}),
    ...(options.banner ? { banner: options.banner } : {}),
    tsconfig: resolve(root, "tsconfig.json"),
    logLevel: "warning",
  });
}

function writeApplicationPackage(directory) {
  const manifest = {
    name: "@lite-harness/application",
    version,
    description: "Compiled Lite-Harness Manager, Gateway, launcher, and CLI",
    type: "module",
    license: "MIT",
    engines: { node: ">=24.0.0 <25" },
    files: ["apps", "LICENSE", "README.md"],
    bin: { "lite-harness": "./apps/cli/main.js" },
    exports: {
      "./manager": "./apps/manager/main.js",
      "./gateway": "./apps/gateway/main.js",
      "./launcher": "./apps/launcher/main.js",
      "./cli": "./apps/cli/main.js",
    },
    dependencies: { fastify: "5.8.5" },
  };
  writeFileSync(resolve(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(resolve(root, "LICENSE"), resolve(directory, "LICENSE"));
  copyFileSync(resolve(root, "README.md"), resolve(directory, "README.md"));
}

function emitDeclarations(entry, outDir) {
  execFileSync(process.execPath, [
    resolve(root, "node_modules", "typescript", "bin", "tsc"),
    "--target", "ES2023",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--strict",
    "--skipLibCheck",
    "--declaration",
    "--emitDeclarationOnly",
    "--noEmit", "false",
    "--outDir", outDir,
    entry,
  ], { cwd: root, stdio: "inherit" });
}

function writePackage(directory, details) {
  const manifest = {
    ...details,
    type: "module",
    license: "MIT",
    engines: { node: ">=24.0.0 <25" },
    files: ["dist", "LICENSE", "README.md"],
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(resolve(root, "LICENSE"), resolve(directory, "LICENSE"));
  copyFileSync(resolve(root, "README.md"), resolve(directory, "README.md"));
}
