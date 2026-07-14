import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "docs", "adr");
const ledger = JSON.parse(readFileSync(resolve(root, "docs", "requirements", "alpha-ledger.yaml"), "utf8"));
const frozen = ledger.requirements.filter((row) => row.kind === "frozen-decision");
const plan = readFileSync(resolve(root, "LITE_HARNESS_ARCHITECTURE_PLAN.md"));
const planSha256 = createHash("sha256").update(plan).digest("hex");
const check = process.argv.includes("--check");

const records = [
  ["node-typescript-stack", "Node and TypeScript implementation stack", "a polyglot kernel or a native-first Rust/Go rewrite"],
  ["pnpm-monorepo", "pnpm monorepo", "independent repositories or npm/Yarn workspaces"],
  ["host-agent-loop", "Host-owned model and agent loop", "running the provider client and agent loop inside tool containers"],
  ["docker-tool-boundary", "Docker is the untrusted tool boundary", "placing provider credentials or model traffic inside ordinary tool containers"],
  ["gateway-manager-processes", "Separate Gateway and Manager process roles", "a single privileged web process"],
  ["narrow-local-ipc", "Narrow local Gateway-to-Manager IPC", "a remotely exposed Manager API or shared-database coordination"],
  ["gateway-no-docker-options", "Gateway rejects raw Docker authority", "passing mounts, commands, paths, or daemon options through public requests"],
  ["resource-scoped-authorization", "Resource-scoped public authorization", "endpoint-only authentication without tenant, user, and resource checks"],
  ["opaque-short-lived-tokens", "Short-lived opaque external tokens", "custom encrypted bearer tokens or self-contained long-lived JWTs"],
  ["resolved-internal-principal", "Manager receives a resolved principal", "forwarding public bearer tokens into the privileged Manager"],
  ["sqlite-wal-first", "SQLite WAL as the first database", "requiring an external database for the local-first alpha"],
  ["durable-runs-events", "Durable runs and events", "process-memory run ownership as the system of record"],
  ["single-workspace-writer", "Single writable run per workspace", "concurrent unsynchronized workspace writers"],
  ["workspace-fencing", "Fenced workspace leases", "time-only or best-effort locks without stale-writer rejection"],
  ["named-volume-default", "Managed named-volume workspaces", "arbitrary host bind mounts as the default workspace mode"],
  ["registered-bind-mounts", "Registered host-project developer mode", "accepting arbitrary host paths from callers"],
  ["encrypted-cold-snapshots", "Encrypted authenticated cold snapshots", "treating live Docker volumes as the only recovery format"],
  ["tenant-private-cache", "Tenant-private cache ownership", "global cache reuse based only on matching content hashes"],
  ["docker-owned-layer-cache", "Docker-owned image and layer caching", "a second custom build-layer cache inside Lite-Harness"],
  ["optional-pxpipe-after-routing", "Optional pxpipe after route selection", "unconditional context encoding before provider/model selection"],
  ["exact-canonical-context", "Exact text remains canonical context", "using a rendered image as the only recoverable context"],
  ["honest-docker-containment", "Docker containment is not a micro-VM boundary", "claiming hostile multi-tenant isolation from regular Docker alone"],
  ["contract-only-kernel", "Kernel depends only on contracts", "kernel imports of concrete providers, browsers, integrations, or plugins"],
  ["lazy-capability-packs", "Large features are lazy capability packs", "an always-loaded ecosystem bundle"],
  ["out-of-process-plugins", "Third-party plugins run out of process", "loading unreviewed third-party code into the trusted host process"],
  ["native-direct-delegated-subscription", "Native direct APIs and delegated subscription adapters", "emulating subscription-backed agents through direct API routes"],
  ["separate-auth-domains", "Separate app, provider, and integration authentication", "a shared credential namespace across security domains"],
  ["opaque-credential-profiles", "Opaque credential profiles", "copying provider keys into prompts, configs, or tool containers"],
  ["capability-policy-routing", "Capability- and policy-based model routing", "ordered string substitution as the routing model"],
  ["compile-after-route", "Compile canonical requests after route selection", "provider-specific request compilation before the final route is known"],
  ["openclaw-compat-adapter", "OpenClaw compatibility is an adapter", "retaining OpenClaw internals as the permanent kernel"],
  ["behavior-defined-compatibility", "Compatibility is defined by behavior", "using file and folder similarity as compatibility evidence"],
];

if (frozen.length !== 32 || records.length !== 32) throw new Error("Expected exactly 32 frozen decisions and ADR definitions");
if (planSha256 !== ledger.baseline.architectureContractSha256) throw new Error("Architecture plan hash no longer matches the frozen ledger baseline");

mkdirSync(outputDir, { recursive: true });
const rendered = [];
for (let index = 0; index < records.length; index += 1) {
  const row = frozen[index];
  const [slug, title, rejectedAlternative] = records[index];
  const number = String(index + 1).padStart(4, "0");
  const path = resolve(outputDir, `${number}-${slug}.md`);
  const content = renderAdr({ number, row, title, rejectedAlternative });
  rendered.push({ number, row, title, path, relative: `docs/adr/${number}-${slug}.md`, content });
}

const indexContent = renderIndex(rendered);
const indexPath = resolve(outputDir, "README.md");
let stale = false;
for (const item of rendered) stale = compareOrWrite(item.path, item.content) || stale;
stale = compareOrWrite(indexPath, indexContent) || stale;

if (check && stale) {
  process.stderr.write("Frozen ADRs are stale; run pnpm generate:adrs:frozen.\n");
  process.exitCode = 1;
} else if (check) {
  process.stdout.write("Frozen ADR checks passed for 32 decisions.\n");
} else {
  process.stdout.write("Generated 32 frozen architecture ADRs and index.\n");
}

function compareOrWrite(path, content) {
  if (check) {
    try { return readFileSync(path, "utf8").replaceAll("\r\n", "\n") !== content; }
    catch { return true; }
  }
  writeFileSync(path, content);
  return false;
}

function renderAdr({ number, row, title, rejectedAlternative }) {
  const impact = impactFor(Number(row.id.slice(1)));
  return `# ADR ${number}: ${title}\n\n` +
    `- Status: accepted\n- Date: 2026-07-14\n- Requirement: ${row.id}\n` +
    `- Contract: \`${row.source.document}\`, ${row.source.section}, lines ${row.source.lineStart}-${row.source.lineEnd}\n` +
    `- Contract SHA-256: \`${planSha256}\`\n\n` +
    `## Context\n\nThe frozen architecture contract requires:\n\n> ${row.text}\n\n` +
    `## Decision\n\n${row.text}\n\n` +
    `This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.\n\n` +
    `## Alternatives considered\n\n- Rejected: ${rejectedAlternative}. It weakens the selected local-first boundary or creates a second architecture to support.\n- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.\n\n` +
    `## Security impact\n\n${impact.security}\n\n` +
    `## Compatibility impact\n\n${impact.compatibility}\n\n` +
    `## Migration plan\n\n${impact.migration}\n`;
}

function impactFor(id) {
  if (id <= 2) return {
    security: "Supply-chain and runtime risk are concentrated in one pinned Node/pnpm toolchain. Lockfile, engine, action, and artifact checks must remain deterministic.",
    compatibility: "Supported packages and SDK artifacts share one versioned workspace contract. Browser consumers receive built SDK output, not Node-only internals.",
    migration: "Keep Node 24 and pnpm 11 pinned for alpha, compile all publishable artifacts, and introduce another language or repository only behind a versioned process/API boundary.",
  };
  if (id <= 7) return {
    security: "Provider credentials and daemon authority stay in the privileged host plane; untrusted commands receive only brokered, policy-checked capabilities.",
    compatibility: "Gateway and Manager may evolve independently only through versioned local IPC. Public clients cannot depend on Docker or host-path details.",
    migration: "Move privileged operations behind typed Manager commands, reject raw authority at Gateway schemas, and remove any direct Gateway imports of runtime/provider implementations.",
  };
  if (id <= 10) return {
    security: "Authentication is resolved once at the public boundary, then enforced as scoped internal identity. Token leakage, replay, and confused-deputy exposure are reduced.",
    compatibility: "Clients use stable bearer-token semantics while internal principal schemas can version independently. Token formats are not a public persistence contract.",
    migration: "Introduce short TTLs, revocation and resource binding; resolve tokens in Gateway; pass only a versioned principal envelope to Manager; invalidate legacy long-lived credentials.",
  };
  if (id <= 14) return {
    security: "Durable transactional state and fencing prevent stale or concurrent writers from corrupting workspaces and lifecycle history.",
    compatibility: "Run/event schemas and lease semantics become versioned persistence contracts. SQLite remains replaceable behind storage interfaces.",
    migration: "Add ordered migrations, WAL/durability settings, transactional lifecycle operations, one-writer queues, lease renewal, and monotonic fencing before importing existing state.",
  };
  if (id <= 19) return {
    security: "Host paths, snapshots, caches, and build layers are assigned explicit owners. Encryption and tenant boundaries cannot be inferred from content hashes alone.",
    compatibility: "Named volumes are portable across supported Docker hosts; developer bind mounts require explicit registration and narrower support claims.",
    migration: "Inventory existing workspaces, register allowed host roots, snapshot cold state into a versioned authenticated format, and let Docker/BuildKit rebuild disposable caches.",
  };
  if (id <= 22) return {
    security: "Optional context transforms cannot erase canonical evidence, and Docker containment is described without overstating its resistance to a hostile co-tenant or daemon compromise.",
    compatibility: "Providers always have an exact-text fallback. pxpipe and image-context behavior remain optional, measurable capabilities rather than kernel requirements.",
    migration: "Persist exact canonical context, apply transforms only after routing, add kill switches and recovery checks, and narrow deployment claims until stronger isolation is independently proven.",
  };
  if (id <= 25) return {
    security: "Concrete ecosystem code and unreviewed plugins stay outside the trusted kernel and are activated only through explicit capability and process boundaries.",
    compatibility: "Capability-pack and plugin contracts are versioned; disabled packs have zero process, import, timer, socket, container, and network activity.",
    migration: "Move concrete imports to composition roots, publish a narrow plugin SDK, supervise third-party workers, and retain in-process execution only for reviewed built-ins.",
  };
  if (id <= 30) return {
    security: "Provider, app, and integration credentials cannot cross domains. Routing is policy-aware and prevents unsafe failover after side effects or partial streams.",
    compatibility: "Provider-native features are advertised only after capability conformance. Delegated agents preserve their own protocol instead of masquerading as direct APIs.",
    migration: "Introduce opaque credential profiles, capability discovery, persisted route decisions, canonical requests, side-effect-aware fallback, and supervised delegated adapters.",
  };
  return {
    security: "Legacy behavior is isolated behind adapters and characterized fixtures, preventing inherited privilege assumptions from becoming permanent kernel contracts.",
    compatibility: "Only behavior proven by the compatibility suite is preserved. File layout, private symbols, and incidental implementation details are explicitly non-contractual.",
    migration: "Characterize behavior, define a Lite-owned contract, wrap and compare, cut over one surface at a time, then delete legacy production imports while retaining provenance.",
  };
}

function renderIndex(items) {
  const rows = items.map((item) => `| ${item.row.id} | [${item.title}](./${item.relative.split("/").at(-1)}) | accepted |`).join("\n");
  return `# Architecture decision records\n\n` +
    `The 32 frozen decisions below are generated from the immutable architecture contract by \`pnpm generate:adrs:frozen\`. Research, support-matrix, publication, and contradiction ADRs are maintained separately after ADR 0032.\n\n` +
    `| Requirement | Decision | Status |\n| --- | --- | --- |\n${rows}\n`;
}
