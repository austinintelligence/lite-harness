import { readFileSync } from "node:fs";

const provenance = JSON.parse(readFileSync(new URL("../PROVENANCE.json", import.meta.url), "utf8"));
const upstream = provenance.upstreams?.find((entry) => entry.name === "openclaw");
const expected = "834810b3d6e367cbdf69b4c822d220f1a150b14c";
const failures = [];

if (provenance.schemaVersion !== 1) failures.push("PROVENANCE.json schemaVersion must be 1");
if (!upstream) failures.push("OpenClaw upstream entry is missing");
if (upstream?.commit !== expected) failures.push(`OpenClaw baseline must remain pinned to ${expected}`);
if (upstream?.license !== "MIT") failures.push("OpenClaw license metadata must remain MIT");

const upstreamDoc = readFileSync(new URL("../UPSTREAM.md", import.meta.url), "utf8");
if (!upstreamDoc.includes(expected)) failures.push("UPSTREAM.md does not name the pinned baseline");

if (failures.length > 0) {
  process.stderr.write(`Provenance checks failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Provenance checks passed.\n");
}
