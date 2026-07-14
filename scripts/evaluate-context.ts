import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ContextStore, OptionalPxpipeRenderer, PXPIPE_EVALUATED_COMMIT, PXPIPE_EVALUATED_VERSION, evaluateContextRenderer,
} from "@lite-harness/context";

const root = process.cwd();
const corpora = [
  { id: "gateway-trace", kind: "logs" as const, path: "test/gateway-manager.e2e.test.ts" },
  { id: "architecture-trace", kind: "logs" as const, path: "docs/ARCHITECTURE.md" },
  { id: "provider-trace", kind: "logs" as const, path: "test/provider-adapters.test.ts" },
];
const renderer = new OptionalPxpipeRenderer();
const evaluations = [];
for (const corpus of corpora) {
  const store = new ContextStore();
  const block = { id: corpus.id, kind: corpus.kind, exactText: readFileSync(join(root, corpus.path), "utf8"), lossyEligible: true, sensitive: false };
  evaluations.push({ source: corpus.path, ...await evaluateContextRenderer(store, renderer, block, "measurement-only") });
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  pxpipe: { version: PXPIPE_EVALUATED_VERSION, commit: PXPIPE_EVALUATED_COMMIT },
  policy: "measurement-only-disabled-by-default",
  qualityConclusion: "No model-quality claim is made without credentialed paired evaluation; exact-value content remains text.",
  evaluations,
};
writeFileSync(join(root, "docs", "pxpipe-evaluation.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
