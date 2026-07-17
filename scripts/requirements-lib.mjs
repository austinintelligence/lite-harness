import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PLAN_PATH = resolve(import.meta.dirname, "..", "LITE_HARNESS_ARCHITECTURE_PLAN.md");
export const PLAN_SHA256 = "cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f";
export const BASELINE_COMMIT = "f9d522289b500174e4e387b6078f907ea4ac56fa";
export const REQUIREMENT_TIERS = Object.freeze(["alpha", "preview", "beta", "future"]);

const alphaGates = [
  ["Cross-platform profile", "The same immutable Linux image digest completes the same workspace fixture on all advertised Linux, macOS, and Windows environments, including rootless where supported; output tree hashes match."],
  ["Installable TypeScript SDK", "A clean external project installs the packed SDK, compiles without monorepo aliases, tsx, or source links, creates a run through packaged Gateway and Manager, and reaches terminal."],
  ["Reconnect and replay", "After Gateway is killed and restarted midstream, the SDK resumes from the last sequence with gap-free, duplicate-free ordered delivery and no run re-execution."],
  ["Real model-plus-Docker loop", "Packaged processes perform provider tool call, real Docker workspace mutation, tool result, second model turn, and artifact publication without an in-process transport or runtime substitute."],
  ["Zero permanent container secrets", "Unique sentinels prove no app, provider, integration, root-encryption, or IPC secret appears in environment, inspect output, mounts, logs, events, errors, or artifacts for any container."],
  ["One writer with fencing", "Two Managers, lease expiry, a paused stale writer, and resumed mutation prove every stale mutation fails and the filesystem remains valid."],
  ["Limits always", "Agent, browser, init, export, import, copy, restore, cache, and recovery containers enforce every required identity, rootfs, capability, seccomp, network, CPU, memory, PID, time, output, swap, and log limit and fail safely when exceeded."],
  ["Cleanup and reconciliation", "After success, failure, cancel, timeout, OOM, idle, and Manager death, no unwanted containers or processes remain; restart reconciliation removes labeled orphans."],
  ["Workspace durability", "A workspace survives run-container removal, Lite restart, and Docker Engine or Desktop restart with a complete file and metadata tree."],
  ["Automatic encrypted cold restore", "The real compactor performs WARM to CHECKPOINTING to COLD, verifies before volume deletion, and a subsequent run automatically performs RESTORING to WARM with an identical tree hash."],
  ["Previous-good recovery", "Fault injection at every snapshot commit stage plus a corrupt newest archive or pointer restores the previous verified generation without modifying live data from invalid input."],
  ["Artifact ownership", "Cross-app, tenant, and user metadata and byte access returns uniform not-found through real HTTP and both SDKs, including guessed and malformed IDs."],
  ["Cache isolation", "Global cache is immutable, digest-keyed, and read-only; private cache keys include owner; poisoned entries fail, cross-owner sentinels never leak, and active runs survive eviction."],
  ["Doctor", "Fixtures detect missing or wrong Docker, bad mounts, low disk, corrupt or locked DB, migration failure, unavailable key, missing image, invalid config, and unhealthy IPC; healthy exits zero and every required defect exits nonzero with remediation."],
  ["Recovery and export", "Using documented release artifacts only, export and import into a clean installation recovers DB, configuration, workspaces, snapshots, artifacts, and necessary metadata, including the recovery-key procedure."],
  ["Provider conformance", "Direct OpenAI, direct Anthropic, and delegated Codex pass shared automated and live-redacted conformance for streams, tools, cancellation, auth and refresh, usage and cost, rate and error handling, malformed responses, and retry safety."],
  ["Routing and usage", "An incompatible model is rejected before network; frozen selection, capability, health reason, fallback, usage, cost, profile, and catalog generation persist without secrets."],
  ["Plugin lifecycle", "Official isolated and OpenClaw compatibility plugins inspect, install, enable lazily, invoke, hang, crash, back off, restart, upgrade, migrate, roll back, disable, and uninstall through the real Manager without leaks or Manager failure."],
  ["Skills", "Real runs lazily load exact deterministic immutable SKILL.md snapshots with correct precedence and traversal, link, limit, and gating safety; text cannot grant tools, network, or secrets."],
  ["Managed browser", "A recorded real task covers navigation, stable refs, form interaction, screenshot, authorized upload, download promotion, encrypted owner-safe profile save and restore, two owners sharing a profile name, SSRF denial, and actual idle teardown."],
  ["MCP", "Stdio and HTTP tools appear only through normal grants and policy; denied calls remain denied; hang, crash, huge payload, malicious schema, and malformed behavior affects only the broken server and leaves no process."],
  ["Disabled packs, offline, and scale-to-zero", "Disabled packs create zero workers, processes, listeners, timers, sockets, tool schemas, or containers; after enabled use and idle they return to that state; a preloaded offline fake or local run performs zero pulls or outbound connections."],
];

const ownerBySection = new Map([
  [7, "run-coordinator"], [8, "run-coordinator"], [9, "api-sdk"], [10, "identity"],
  [11, "agent-runtime"], [12, "skills"], [13, "compatibility"], [14, "provider-plane"],
  [15, "plugin-runtime"], [16, "optional-packs"], [17, "browser"], [18, "context"],
  [19, "docker-runtime"], [20, "network-policy"], [21, "workspace"], [22, "recovery"],
  [23, "cache"], [24, "artifacts"], [25, "storage"], [26, "recovery"], [27, "security"],
  [28, "cross-platform"], [29, "operations"], [30, "observability"], [31, "packaging"],
  [32, "architecture"], [34, "verification"],
]);

const trackedSections = new Set(ownerBySection.keys());
const normative = /\b(?:must|never|required|requires|only|default|cannot|do not|should|reject|enforce|bounded|durable|authorized|authenticated|isolated|verified)\b/i;

export function extractRequirements(planPath = PLAN_PATH) {
  const lines = readFileSync(planPath, "utf8").replaceAll("\r\n", "\n").split("\n");
  return [
    ...extractDecisions(lines),
    ...extractPhases(lines),
    ...extractAlphaGates(lines),
    ...extractSectionRequirements(lines),
  ];
}

function extractDecisions(lines) {
  const start = lines.findIndex((line) => line.startsWith("## 5."));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## 6."));
  const rows = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(/^(\d+)\.\s+(.+)/);
    if (!match) continue;
    const item = collectContinuation(lines, index, end, /^\d+\.\s+/);
    index = item.end - 1;
    rows.push(makeRow({
      id: `D${match[1].padStart(2, "0")}`,
      kind: "frozen-decision",
      title: `Frozen decision ${match[1]}`,
      text: item.text.replace(/^\d+\.\s+/, ""),
      owner: "architecture",
      section: "5. Architecture decisions to freeze",
      lineStart: item.start + 1,
      lineEnd: item.end,
    }));
  }
  return rows;
}

function extractPhases(lines) {
  const rows = [];
  for (let phase = 0; phase <= 12; phase += 1) {
    const heading = lines.findIndex((line) => line.startsWith(`### Phase ${phase}:`));
    const nextHeading = lines.findIndex((line, index) => index > heading && /^### Phase \d+:/.test(line));
    const end = nextHeading === -1 ? lines.findIndex((line, index) => index > heading && line.startsWith("## 34.")) : nextHeading;
    const exit = lines.findIndex((line, index) => index > heading && index < end && line === "Exit gate:");
    const items = [];
    let lineEnd = exit + 1;
    for (let index = exit + 1; index < end; index += 1) {
      if (!lines[index].startsWith("- ")) continue;
      const item = collectContinuation(lines, index, end, /^-\s+/);
      items.push(item.text.replace(/^-\s+/, ""));
      lineEnd = item.end;
      index = item.end - 1;
    }
    const title = lines[heading].replace(/^###\s+/, "");
    rows.push(makeRow({
      id: `P${String(phase).padStart(2, "0")}`,
      kind: "phase-exit",
      title,
      text: items.join(" "),
      owner: phaseOwner(phase),
      section: `33. Build roadmap / ${title}`,
      lineStart: exit + 1,
      lineEnd,
    }));
  }
  return rows;
}

function extractAlphaGates(lines) {
  const sectionLine = lines.findIndex((line) => line.startsWith("## 35.")) + 1;
  return alphaGates.map(([title, text], index) => makeRow({
    id: `A${String(index + 1).padStart(2, "0")}`,
    kind: "alpha-gate",
    title,
    text,
    owner: alphaOwner(index + 1),
    section: `Goal mission / Alpha acceptance gates / A${String(index + 1).padStart(2, "0")}`,
    lineStart: sectionLine,
    lineEnd: sectionLine,
    sourceDocument: "goal-mission",
  }));
}

function extractSectionRequirements(lines) {
  const rows = [];
  let section = 0;
  let sectionTitle = "";
  let inCode = false;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^## (\d+)\.\s+(.+)/);
    if (heading) {
      section = Number(heading[1]);
      sectionTitle = `${heading[1]}. ${heading[2]}`;
      inCode = false;
      continue;
    }
    if (!trackedSections.has(section)) continue;
    if (lines[index].startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      const code = lines[index].trim();
      if (/^(?:GET|POST|PUT|PATCH|DELETE)\s+\//.test(code)) {
        rows.push(sectionRow(section, sectionTitle, index, index + 1, `Public API endpoint: ${code}`));
      }
      continue;
    }
    const trimmed = lines[index].trim();
    if (/^(?:-\s+|\d+\.\s+)/.test(lines[index])) {
      const item = collectContinuation(lines, index, lines.length, /^(?:-\s+|\d+\.\s+)/);
      rows.push(sectionRow(section, sectionTitle, item.start, item.end, item.text.replace(/^(?:-\s+|\d+\.\s+)/, "")));
      index = item.end - 1;
      continue;
    }
    if (/^(?:GET|POST|PUT|PATCH|DELETE)\s+\//.test(trimmed)) {
      rows.push(sectionRow(section, sectionTitle, index, index + 1, `Public API endpoint: ${trimmed}`));
      continue;
    }
    if (/^lite-harness\s+/.test(trimmed)) {
      rows.push(sectionRow(section, sectionTitle, index, index + 1, `Required CLI command: ${trimmed}`));
      continue;
    }
    if (/^(?:Workspace|Run|Attempt|Browser session|Plugin install|Trigger firing):/.test(trimmed)) {
      rows.push(sectionRow(section, sectionTitle, index, index + 1, `Required state machine: ${trimmed}`));
      continue;
    }
    if (/^\|.+\|$/.test(trimmed) && !/^\|\s*-+/.test(trimmed) && !/^\|\s*(?:Table|Field|Name|Class|Mode|State|Component|Package)\b/i.test(trimmed)) {
      rows.push(sectionRow(section, sectionTitle, index, index + 1, `Required contract row: ${trimmed}`));
      continue;
    }
    if (trimmed.startsWith("|")) continue;
    if (!lines[index] || /^#{2,4}\s/.test(lines[index]) || /^\d+\.\s/.test(lines[index])) continue;
    const paragraph = collectParagraph(lines, index);
    if (normative.test(paragraph.text)) {
      rows.push(sectionRow(section, sectionTitle, paragraph.start, paragraph.end, paragraph.text));
    }
    index = paragraph.end - 1;
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.source.lineStart}:${row.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sectionRow(section, sectionTitle, start, end, text) {
  return makeRow({
    id: `R${String(section).padStart(2, "0")}-${String(start + 1).padStart(4, "0")}`,
    kind: "contract-requirement",
    title: `${sectionTitle} requirement at line ${start + 1}`,
    text,
    owner: ownerBySection.get(section),
    section: sectionTitle,
    lineStart: start + 1,
    lineEnd: end,
  });
}

function makeRow({ id, kind, title, text, owner, section, lineStart, lineEnd, sourceDocument = "LITE_HARNESS_ARCHITECTURE_PLAN.md" }) {
  const tier = requirementTier(id, text);
  return {
    id, kind, tier, required: tier === "alpha", title, text: normalize(text), owner,
    source: { document: sourceDocument, section, lineStart, lineEnd },
    implementationPaths: [], testIds: [], ciJob: null, evidenceArtifacts: [],
    status: "blocked", blockers: ["traceability-not-yet-established"],
  };
}

export function requirementTier(id, text = "") {
  if (/^(?:D|A)/.test(id)) return "alpha";
  if (/^P/.test(id)) {
    if (id === "P10") return "preview";
    return "beta";
  }
  const section = Number(/^R(\d+)-/.exec(id)?.[1] ?? 0);
  // ADR 0052 keeps the complete extracted ledger, but the release gate is the
  // explicit A01-A22 acceptance surface plus frozen architecture decisions.
  // Detailed plan prose remains searchable and traceable without silently
  // turning every endpoint, roadmap bullet, or ecosystem promise into a
  // second alpha gate. The alpha gate text owns the strict scope.
  if (section === 18) return "future";
  if (section === 31 || section === 32 || section === 34) return "beta";
  return "preview";
}

function collectContinuation(lines, start, end, nextItemPattern) {
  const parts = [lines[start].trim()];
  let index = start + 1;
  while (index < end && lines[index].trim() && !nextItemPattern.test(lines[index]) && !/^#{2,4}\s/.test(lines[index])) {
    parts.push(lines[index].trim());
    index += 1;
  }
  return { start, end: index, text: normalize(parts.join(" ")) };
}

function collectParagraph(lines, start) {
  const parts = [];
  let index = start;
  while (index < lines.length && lines[index].trim() && !/^#{2,4}\s/.test(lines[index]) && !/^(?:-\s|\d+\.\s|\|)/.test(lines[index]) && !lines[index].startsWith("```")) {
    parts.push(lines[index].trim());
    index += 1;
  }
  return { start, end: index, text: normalize(parts.join(" ")) };
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

function phaseOwner(phase) {
  if (phase === 0) return "architecture";
  if (phase <= 2) return "kernel";
  if (phase === 3) return "docker-runtime";
  if (phase === 4) return "provider-plane";
  if (phase === 5) return "recovery";
  if (phase === 6) return "extensibility";
  if (phase === 7) return "browser";
  if (phase <= 10) return "optional-packs";
  return "release";
}

function alphaOwner(gate) {
  if (gate <= 3) return "api-sdk";
  if (gate <= 9) return "docker-runtime";
  if (gate <= 15) return "durability";
  if (gate <= 17) return "provider-plane";
  if (gate <= 19) return "extensibility";
  if (gate === 20) return "browser";
  return "extensibility";
}
