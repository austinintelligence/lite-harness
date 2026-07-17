import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "docs", "adr");
const check = process.argv.includes("--check");
const retrieved = "2026-07-14";

const records = [
  {
    number: 33, slug: "public-identity", title: "Public identity and publication namespace", status: "blocked", items: "Research 1",
    sources: [
      ["npm scopes", "https://docs.npmjs.com/cli/v11/using-npm/scope", "npm CLI 11"],
      ["Python package name normalization", "https://packaging.python.org/en/latest/specifications/name-normalization/", "current PyPA specification"],
      ["GitHub Container Registry", "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry", "current GHCR documentation"],
    ],
    decision: "Lite-Harness remains an internal codename. No npm scope, PyPI project, container namespace, domain, or public product identity is approved until the owner supplies one collision-checked name and publication scope. Private workspace package names may continue to use the codename while every package remains private.",
    alternatives: "Silently claiming an available-looking name; publishing first and renaming later; treating different registry normalizations as equivalent.",
    security: "Prevents namespace squatting, dependency confusion, and accidental publication to an identity the owner does not control.",
    compatibility: "Public package and image coordinates are intentionally not stable. Internal imports are not a promise to external consumers.",
    migration: "Owner selects the name and scopes; verify normalized names in npm, PyPI, GitHub, GHCR, domains, and trademark search; update manifests/docs/workflows atomically; publish only from an approved signed release.",
    release: "Blocks naming approval, signing identity, registry promotion, and every public alpha publication gate.",
  },
  {
    number: 34, slug: "supported-platform-matrix", title: "Supported platform and container matrix", status: "provisional", items: "Research 2",
    sources: [
      ["Node release schedule", "https://nodejs.org/en/about/previous-releases", "Node 24 LTS"],
      ["Docker Desktop for macOS", "https://docs.docker.com/desktop/setup/install/mac-install/", "current and two previous macOS majors"],
      ["Docker Desktop for Windows", "https://docs.docker.com/desktop/setup/install/windows-install/", "WSL2 backend"],
      ["Docker rootless mode", "https://docs.docker.com/engine/security/rootless/", "current Docker Engine"],
    ],
    decision: "The verified-alpha matrix is Node 24 LTS on Ubuntu 24.04 LTS amd64/arm64, macOS versions currently supported by Docker Desktop on Intel and Apple silicon, and Windows 11 with a current WSL2 kernel and Docker Desktop Linux containers. Ubuntu 24.04 rootless Docker is a required separate lane. Debian 12/13 and newer Linux distributions are compatible-but-unverified until evidence exists. Compose is not required.",
    alternatives: "Claiming all modern Linux distributions; treating WSL2 as native Windows containers; supporting macOS architectures without Docker Desktop evidence.",
    security: "A bounded matrix makes filesystem, socket, credential-store, rootless, sleep/resume, and daemon-restart assumptions testable.",
    compatibility: "Unlisted platforms may work but are unsupported. Alpha claims require exact OS, architecture, Docker client/server, context, and kernel evidence.",
    migration: "Create external lanes for Linux rootful/rootless arm64, macOS Intel/Apple silicon, and Windows 11 WSL2; narrow docs automatically when a required lane is missing.",
    release: "Provisional until every named lane has current zero-skip packaged-boundary evidence.",
  },
  {
    number: 35, slug: "node-build-and-sdk-targets", title: "Node, TypeScript, and SDK build targets", status: "accepted", items: "Research 3",
    sources: [
      ["Node release schedule", "https://nodejs.org/en/about/previous-releases", "Node 24 LTS"],
      ["TypeScript module compiler guidance", "https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html", "TypeScript 5.9"],
    ],
    decision: "Node 24 LTS and TypeScript 5.9 are the alpha toolchain. Applications and the TypeScript SDK must ship compiled ESM with declarations and source maps. The alpha SDK is Node-only; browser support requires a later fetch-only package with no Node built-ins. Production entry points must not require tsx, workspace links, or source files.",
    alternatives: "Running TypeScript source in production; dual CJS/ESM output without consumer evidence; claiming browser support from type compatibility alone.",
    security: "Compiled, exported entry points reduce runtime loader ambiguity and keep private source paths out of the supported surface.",
    compatibility: "Consumers get an explicit Node engine range and ESM contract. CommonJS and browsers are not alpha-supported.",
    migration: "Add per-package build outputs and export maps, pack/install fixtures, declaration checks, and Node 24 external-consumer tests before any package is publishable.",
    release: "Blocks M1 until compiled apps, packed SDK, wheel/sdist, and clean external installs run without workspace dependencies.",
  },
  {
    number: 36, slug: "tool-runtime-image", title: "Tool runtime image composition and patch policy", status: "accepted", items: "Research 4",
    sources: [
      ["Dockerfile best practices", "https://docs.docker.com/build/building/best-practices/", "current Docker Build"],
      ["Playwright Docker and glibc support", "https://playwright.dev/docs/docker", "Playwright 1.61.1"],
      ["Node official images", "https://github.com/nodejs/docker-node", "Node 24 bookworm-slim"],
    ],
    decision: "Replace the Alpine/BusyBox tool image with a digest-pinned Debian bookworm-slim/glibc image containing Node 24, CA certificates, tini, bash, git, and a package-manager shim. Keep Python in an explicit opt-in profile. Build amd64 and arm64 from the same Dockerfile, record image digests, and refresh base digests through reviewed dependency updates.",
    alternatives: "The current seven-line Alpine image; floating latest tags; one maximal image containing every language toolchain.",
    security: "Digest pinning, non-root execution, a minimal package set, init handling, and reproducible rebuilds reduce image drift and orphan processes.",
    compatibility: "glibc supports common native Node tooling that musl images do not. Optional Python avoids imposing its patch surface on every run.",
    migration: "Add the Debian image, health/UID/multiarch fixtures, package inventory and SBOM; migrate tool profiles; delete Alpine only after equivalent lifecycle tests pass.",
    release: "The current Alpine image does not satisfy this ADR and blocks the verified runtime boundary.",
  },
  {
    number: 37, slug: "docker-engine-control-plane", title: "Docker Engine control-plane contract", status: "accepted", items: "Research 5",
    sources: [
      ["Docker Engine API", "https://docs.docker.com/reference/api/engine/", "versioned Engine API"],
      ["Docker object labels", "https://docs.docker.com/engine/manage-resources/labels/", "current Docker Engine"],
      ["Docker resource constraints", "https://docs.docker.com/engine/containers/resource_constraints/", "current Docker Engine"],
      ["Docker rootless mode", "https://docs.docker.com/engine/security/rootless/", "current Docker Engine"],
    ],
    decision: "Use the version-negotiated Docker Engine API for create/start/inspect/wait/events/stop/remove and managed volumes. Every owned object carries stable ownership labels. Apply CPU, memory, pids, read-only-root, capability, network, and mount policy at create time. Reconcile from labels and inspect state after daemon restart, host resume, or event-stream loss. Rootless is a required reduced-capability lane, not a transparent synonym for rootful.",
    alternatives: "Parsing human CLI output as the control contract; relying on container names alone; assuming the event stream is lossless.",
    security: "Ownership labels and create-time constraints prevent accidental adoption/removal and limit tool authority.",
    compatibility: "API negotiation tolerates supported Engine versions; features unavailable in rootless mode must fail closed or be declared unsupported.",
    migration: "Centralize Docker calls in one adapter, add restart/resume reconciliation and conflict fixtures, then remove scattered CLI assumptions.",
    release: "Requires rootful/rootless lifecycle, label-conflict, daemon-restart, and cleanup evidence.",
  },
  {
    number: 38, slug: "credential-storage-and-recovery", title: "Credential storage, recovery, and rotation", status: "accepted", items: "Research 6",
    sources: [
      ["Secret Service API", "https://specifications.freedesktop.org/secret-service/latest-single/", "freedesktop.org specification"],
      ["Apple Keychain Services", "https://developer.apple.com/documentation/security/keychain-services", "current Security framework"],
      ["Windows credential management", "https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-management", "current Win32 API"],
      ["Windows Data Protection API", "https://learn.microsoft.com/en-us/windows/win32/secauthn/data-protection", "DPAPI"],
    ],
    decision: "Store small credential records in Secret Service on desktop Linux, Keychain SecItem APIs on macOS, and user-scoped DPAPI-protected records on Windows. Headless Linux without an unlocked Secret Service collection must require an explicit operator-supplied recovery key/passphrase; it must not fall back to plaintext. Keep provider keys, snapshot wrapping keys, and integration secrets in separate namespaces with versioned key IDs and online rotation.",
    alternatives: "Plaintext dotfiles; environment variables as durable storage; one shared master secret without versioning.",
    security: "Uses OS access controls while making headless failure explicit. Separation and key IDs support least privilege, revocation, and staged re-encryption.",
    compatibility: "Credential portability is by export/import of an encrypted recovery envelope, not copying OS store files.",
    migration: "Implement native adapters, migrate existing encrypted records, generate recovery material once with confirmation, support old/new key overlap, then destroy retired key material after verification.",
    release: "Requires locked/unlocked, missing-store, rotation, recovery, and redaction tests on each supported OS.",
  },
  {
    number: 39, slug: "sqlite-driver-and-durability", title: "SQLite driver maturity and durability policy", status: "provisional", items: "Research 7",
    sources: [
      ["Node SQLite API", "https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html", "Node 24.18.0, stability 1.2 release candidate"],
      ["SQLite WAL", "https://sqlite.org/wal.html", "current SQLite"],
      ["SQLite pragmas and integrity checks", "https://sqlite.org/pragma.html", "current SQLite"],
      ["SQLite online backup API", "https://sqlite.org/backup.html", "current SQLite"],
    ],
    decision: "SQLite WAL remains the first database with foreign keys enabled, bounded busy handling, FULL synchronous durability for authoritative state, explicit checkpoints, ordered transactional migrations, online backup, quick checks during operation, and full integrity plus foreign-key checks for release/recovery. Node's built-in SQLite driver is allowed only in pre-alpha while it remains release-candidate stability; verified alpha requires either stable Node status or a mature supported replacement selected by a superseding ADR.",
    alternatives: "Declaring a release-candidate API stable by local test success; synchronous OFF/NORMAL for authoritative lifecycle commits; file copying a live WAL database as backup.",
    security: "Transactional ownership and integrity checks reduce contradictory state and tampered/corrupt recovery acceptance.",
    compatibility: "Storage interfaces and migrations must not expose driver-specific statement objects. Backup format is SQLite plus manifest, not a Node API contract.",
    migration: "Complete cross-process locking and crash tests, benchmark FULL WAL, evaluate a stable replacement, and migrate behind the storage adapter without changing public contracts.",
    release: "Current node:sqlite stability is an explicit verified-alpha blocker.",
  },
  {
    number: 40, slug: "snapshot-crypto-compression-format", title: "Snapshot encryption, compression, and atomic publication", status: "accepted", items: "Research 8",
    sources: [
      ["libsodium secretstream", "https://doc.libsodium.org/secret-key_cryptography/secretstream", "XChaCha20-Poly1305 secretstream"],
      ["Zstandard", "https://facebook.github.io/zstd/", "zstd 1.5.7 and RFC 8878"],
      ["Node filesystem API", "https://nodejs.org/download/release/latest-v24.x/docs/api/fs.html", "Node 24"],
    ],
    decision: "Snapshot format v1 is a versioned manifest plus a bounded zstd stream encrypted and authenticated with libsodium secretstream. Generate a per-snapshot data key, wrap it with a versioned root key, authenticate metadata as associated data, enforce chunk/window/output limits before extraction, write to a same-filesystem temporary path, fsync file data, atomically replace the target, and fsync the parent directory where supported.",
    alternatives: "Whole-file AES-GCM buffering; unauthenticated compression; rename without durable flush; extracting paths before validation.",
    security: "Streaming AEAD, key hierarchy, authenticated metadata, and decompression/path limits address tampering, nonce misuse, zip bombs, and traversal.",
    compatibility: "The archive version and algorithms are explicit and language-neutral; readers may support multiple versions during rotation.",
    migration: "Implement v1 alongside the current envelope, round-trip and tamper fixtures, bounded-memory multi-GB tests, recovery-key rewrap, then migrate snapshots lazily on successful read.",
    release: "Requires cross-platform power-loss/replace semantics evidence and recovery drills.",
  },
  {
    number: 41, slug: "openai-responses-and-codex", title: "OpenAI Responses and delegated Codex integration", status: "accepted", items: "Research 9",
    sources: [
      ["OpenAI Responses API", "https://platform.openai.com/docs/api-reference/responses", "current Responses API"],
      ["OpenAI streaming events", "https://platform.openai.com/docs/api-reference/responses-streaming/response/function_call_arguments/done?api-mode=responses", "current Responses streaming events"],
      ["OpenAI data controls", "https://platform.openai.com/docs/models/default-usage-policies-by-endpoint", "current endpoint retention policy"],
      ["Codex app-server", "https://developers.openai.com/codex/app-server", "stdio JSONL; WebSocket experimental"],
    ],
    decision: "Use the Responses API as the native OpenAI direct route, including typed streaming events, tools, structured output, usage, incomplete/error states, request IDs, and explicit store/data-control options. Keep generic OpenAI-compatible Chat Completions as a separate compatibility route. Integrate subscription-backed Codex through supervised app-server stdio JSONL; do not depend on its experimental WebSocket transport. Local model-backed tests continue through the configured localhost Hermes proxy.",
    alternatives: "Treating Chat Completions as the permanent OpenAI-native contract; scraping Codex terminal output; using experimental app-server WebSocket for alpha.",
    security: "Credentials remain in the provider/delegated supervisor; storage choices and tool approvals are explicit; app-server output is bounded and fail-closed.",
    compatibility: "Responses, compatible chat, and delegated Codex expose normalized Lite events without pretending their native capabilities are identical.",
    migration: "Add a Responses adapter and conformance fixtures, persist route and request IDs, supervise app-server lifecycle/version negotiation, and retain the Hermes wrapper for all local inference tests.",
    release: "Requires live Responses-compatible and delegated Codex conformance evidence with no direct credential discovery.",
  },
  {
    number: 42, slug: "anthropic-messages-and-claude", title: "Anthropic Messages and delegated Claude integration", status: "accepted", items: "Research 10",
    sources: [
      ["Anthropic Messages API", "https://platform.claude.com/docs/en/api/messages", "current Claude API"],
      ["Anthropic streaming", "https://platform.claude.com/docs/en/build-with-claude/streaming", "current SSE event model"],
      ["Anthropic errors", "https://platform.claude.com/docs/en/api/errors", "current error contract"],
      ["Anthropic prompt caching", "https://platform.claude.com/docs/en/build-with-claude/prompt-caching", "current cache controls"],
    ],
    decision: "Use the native Anthropic Messages API for direct Claude routes, preserving content blocks, tool-use/tool-result IDs, streaming deltas, cache accounting, usage, request IDs, overload/rate-limit semantics, and terminal errors. Treat Claude Code subscription workflows as a separately supervised delegated adapter with explicit protocol/version fixtures; never infer direct-API capability from delegated access.",
    alternatives: "Routing Anthropic through a lossy OpenAI-shaped adapter; treating CLI text as a protocol; assuming prompt cache writes/reads are ordinary input tokens.",
    security: "Direct and delegated credentials remain separate; retries stop after side effects or partial output; prompt-cache and provider data behavior are visible to policy.",
    compatibility: "Native blocks are normalized without erasing provider-specific metadata. Unsupported capabilities fail before dispatch.",
    migration: "Complete native stream/error/cache conformance, add delegated version negotiation and cancellation, and persist normalized plus provider request metadata.",
    release: "Direct Anthropic and delegated Claude remain preview until independent live evidence is available through an owner-approved route.",
  },
  {
    number: 43, slug: "provider-support-tiers", title: "Provider support tiers and conformance", status: "accepted", items: "Research 11 and alpha provider breadth",
    sources: [
      ["xAI API reference", "https://docs.x.ai/docs/api-reference", "current xAI API"],
      ["OpenRouter API", "https://openrouter.ai/docs/api/reference/overview", "current OpenRouter API"],
      ["Gemini function calling", "https://ai.google.dev/gemini-api/docs/function-calling", "current Gemini API"],
      ["Kimi API overview", "https://platform.kimi.ai/docs/api/overview", "current Kimi API"],
      ["MiniMax API", "https://platform.minimax.io/docs/api-reference/text-anthropic-api", "current MiniMax API"],
    ],
    decision: "Alpha-supported provider lanes are fake/deterministic, OpenAI Responses, OpenAI-compatible, Anthropic Messages, and delegated Codex only after each exact lane passes capability, stream, tool, usage, cancellation, retry, and error conformance. Delegated Claude, OpenRouter, Gemini, xAI, Kimi/Moonshot, and MiniMax are preview until the same evidence exists. A preset or successful text response is not provider support.",
    alternatives: "Advertising every configured base URL; assuming OpenAI-compatible means tool/usage/error compatibility; counting preview providers toward alpha gates.",
    security: "Capability admission before dispatch prevents silent tool loss, unsafe retry, credential-domain confusion, and unbounded streams.",
    compatibility: "Each route publishes a tested capability vector and native-version notes. Preview routes may change or be removed without alpha compatibility promises.",
    migration: "Build a shared provider conformance suite, run it live through owner-approved routes, persist results by commit/model, and promote one provider at a time.",
    release: "Missing required direct OpenAI, Anthropic, or delegated Codex evidence blocks verified alpha; preview breadth does not.",
  },
  {
    number: 44, slug: "mcp-version-transports-auth", title: "MCP version, transports, lifecycle, and auth", status: "accepted", items: "Research 12",
    sources: [
      ["MCP overview", "https://modelcontextprotocol.io/specification/2025-11-25/basic", "protocol 2025-11-25"],
      ["MCP transports", "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports", "stdio and Streamable HTTP"],
      ["MCP authorization", "https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization", "OAuth-based HTTP authorization"],
      ["MCP lifecycle", "https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle", "protocol 2025-11-25"],
    ],
    decision: "Target MCP 2025-11-25 with stdio and Streamable HTTP. Stdio stdout contains only JSON-RPC messages and logs use stderr. Local HTTP binds loopback, validates Origin, authenticates every connection, and enforces bounded schemas. Remote HTTP follows MCP authorization, TLS, audience binding, and no token passthrough. Legacy HTTP+SSE is compatibility-only; experimental tasks and custom transports are preview.",
    alternatives: "Treating old HTTP+SSE as the primary transport; unauthenticated 0.0.0.0 listeners; forwarding client bearer tokens to upstream APIs.",
    security: "Origin checks, loopback defaults, authentication, token audience binding, schema limits, and subprocess supervision address DNS rebinding and confused-deputy risks.",
    compatibility: "Protocol version negotiation is mandatory; unsupported versions/capabilities fail explicitly. Resources/prompts/tools retain their MCP schemas.",
    migration: "Add 2025-11-25 initialize/capability fixtures, Streamable HTTP resume/cancel tests, OAuth metadata validation, and a bounded legacy adapter.",
    release: "Requires real stdio and Streamable HTTP lifecycle tests; legacy and experimental features cannot satisfy core gates.",
  },
  {
    number: 45, slug: "playwright-browser-container", title: "Playwright and Chromium browser container", status: "accepted", items: "Research 13",
    sources: [
      ["Playwright Docker", "https://playwright.dev/docs/docker", "Playwright 1.61.1"],
      ["Playwright browser installation", "https://playwright.dev/docs/browsers", "current Playwright"],
      ["Playwright BrowserType API", "https://playwright.dev/docs/api/class-browsertype", "current Playwright"],
    ],
    decision: "Pin the Playwright package and Microsoft image to the same patch version and digest. Run the browser server as non-root pwuser with init and the documented sandbox-compatible seccomp profile; never add SYS_ADMIN in production. Use an isolated profile, bounded downloads/artifacts, explicit CDP policy, and brokered egress. Do not claim the container alone is safe for hostile websites.",
    alternatives: "Version-mismatched package/image pairs; root with Chromium sandbox disabled; host-browser reuse as the default managed mode.",
    security: "Non-root Chromium sandboxing, seccomp, network policy, profile isolation, and artifact bounds reduce browser-to-host and cross-run exposure.",
    compatibility: "Browser protocol compatibility follows the exact Playwright version. Remote CDP and branded browsers are preview unless separately proven.",
    migration: "Upgrade both package and image to 1.61.1, add the seccomp profile/init, prove sandbox state and download/profile cleanup, then remove the mismatched image.",
    release: "The current 1.61.0 image is behind current 1.61.1 guidance and blocks the browser boundary until migrated and tested.",
  },
  {
    number: 46, slug: "cross-platform-plugin-sandbox", title: "Cross-platform plugin sandbox strategy", status: "accepted", items: "Research 14",
    sources: [
      ["Docker seccomp", "https://docs.docker.com/engine/security/seccomp/", "current Docker Engine"],
      ["Docker rootless mode", "https://docs.docker.com/engine/security/rootless/", "current Docker Engine"],
      ["Docker resource constraints", "https://docs.docker.com/engine/containers/resource_constraints/", "current Docker Engine"],
    ],
    decision: "Executable third-party plugins use disposable restricted Linux containers on every supported host, including the Docker Desktop Linux VM on macOS/Windows. Default policy is non-root, read-only root, drop all capabilities, no-new-privileges, default/custom seccomp, pids/CPU/memory limits, no Docker socket, no host network, tmpfs scratch, allowlisted mounts, and brokered network. Native subprocess plugins are trusted-preview only and cannot satisfy the untrusted-plugin alpha gate.",
    alternatives: "Claiming equivalent native OS sandboxes without one enforceable cross-platform policy; in-process VM modules; unrestricted child processes.",
    security: "Creates one auditable minimum boundary while acknowledging Docker daemon/VM trust and rootless limitations.",
    compatibility: "Plugins target the versioned RPC/capability contract rather than host syscalls. Platform-specific native plugins are outside alpha support.",
    migration: "Move executable plugins to the container supervisor, add permission UX and denial tests, and quarantine or relabel native adapters as trusted preview.",
    release: "Requires escape-attempt, quota, mount, network, cleanup, and rootless evidence on the supported matrix.",
  },
  {
    number: 47, slug: "openclaw-preservation-boundary", title: "OpenClaw preservation boundary", status: "accepted", items: "Research 15",
    sources: [
      ["Pinned OpenClaw source", "https://github.com/openclaw/openclaw/commit/834810b3d6e367cbdf69b4c822d220f1a150b14c", "baseline commit 834810b3"],
      ["Lite provenance", "../../PROVENANCE.json", "schema version 1"],
      ["Compatibility contract", "./0031-openclaw-compat-adapter.md", "ADR 0031"],
      ["Behavior contract", "./0032-behavior-defined-compatibility.md", "ADR 0032"],
    ],
    decision: "Preserve only behavior selected by an explicit inventory and executable fixtures from the pinned OpenClaw baseline. Skills precedence, plugin/browser/provider/integration behavior, config import, and migration semantics are characterized independently. Upstream source remains provenance and research material; it is not continuously merged and cannot re-enter the Lite kernel.",
    alternatives: "Tracking OpenClaw main by merge; preserving every user-visible behavior; using copied file layout as evidence.",
    security: "Prevents inherited broad privilege and credential assumptions from bypassing Lite-owned contracts.",
    compatibility: "Every preserved, adapted, preview, deferred, and removed behavior gets a reason and fixture. Uninventoried behavior is not promised.",
    migration: "Complete the behavior inventory, capture fixtures at the pinned commit, implement through adapters, compare, and delete legacy production imports surface by surface.",
    release: "Blocks compatibility claims until the inventory and required fixtures are complete.",
  },
  {
    number: 48, slug: "pxpipe-version-and-evaluation", title: "pxpipe version, license, and evaluation policy", status: "accepted", items: "Research 16",
    sources: [
      ["pxpipe installation", "https://pxpipe.dev/installation", "current documentation"],
      ["pxpipe repository", "https://github.com/teamchong/pxpipe", "upstream source"],
      ["npm registry metadata", "https://registry.npmjs.org/pxpipe-proxy/0.8.0", "pxpipe-proxy 0.8.0, MIT"],
    ],
    decision: "The plan's 0.7.1 versus 0.8.0 conflict is resolved in favor of the plan-pinned pxpipe-proxy 0.8.0 release under MIT; the same-day 0.9.0 release does not satisfy the repository's dependency minimum-age policy. pxpipe remains optional, disabled by default, and runs only after final route selection while exact text stays canonical. Promotion requires measured end-to-end task quality plus full provider-billed input/image/output/cache tokens, cost, latency, recovery, failure, and memory - not PNG byte size alone.",
    alternatives: "Freezing either stale plan version; enabling from image-size reduction; applying it before model selection.",
    security: "Exact canonical recovery and kill switches prevent irreversible context loss; optional loading keeps its attack/resource surface absent when disabled.",
    compatibility: "0.8.0 is pinned only for evaluation until its API and model behavior pass fixtures. The plugin contract isolates future upgrades.",
    migration: "Upgrade the optional dependency to 0.8.0, update API fixtures, run deterministic recovery tests and Hermes-routed model evals, then keep disabled unless thresholds are met.",
    release: "pxpipe is preview and cannot satisfy an alpha gate; its stale 0.7.1 dependency must be corrected.",
  },
  {
    number: 49, slug: "supply-chain-and-promotion", title: "Supply-chain attestations and registry promotion", status: "accepted", items: "Research 17",
    sources: [
      ["GitHub artifact attestations", "https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations", "current GitHub Actions"],
      ["CycloneDX specification", "https://cyclonedx.org/specification/overview/", "CycloneDX 1.6"],
      ["OCI image specification", "https://github.com/opencontainers/image-spec", "current OCI image spec"],
    ],
    decision: "Release artifacts are built once from an immutable tag after the strict gate, hashed, accompanied by CycloneDX SBOMs, and attested by GitHub OIDC provenance to the exact commit/workflow. Container images publish by digest plus immutable version tag; prereleases never move latest. Promotion reuses verified digests rather than rebuilding. Actions and base images remain commit/digest pinned.",
    alternatives: "Rebuilding for each registry; mutable latest-only releases; unsigned locally produced artifacts; SBOMs without artifact linkage.",
    security: "Attestations, immutable digests, least-privilege workflow permissions, and reproducible SBOMs make source-to-artifact substitution detectable.",
    compatibility: "Consumers can verify a stable digest and provenance independently of registry tags. Promotion does not alter bytes.",
    migration: "Add attestations and digest outputs to the gated release workflow, attach package/image/SBOM evidence, configure owner-approved signing/registry permissions, and verify with gh before promotion.",
    release: "Signing authority and registry promotion remain external blockers; branch CI must never receive release write permissions.",
  },
  {
    number: 50, slug: "performance-budgets", title: "Performance and zero-idle budgets", status: "provisional", items: "Research 18",
    sources: [
      ["Kernel benchmark command", "../../scripts/benchmark-kernel.mjs", "local deterministic benchmark"],
      ["Release evidence schema", "../../schemas/release-evidence.schema.json", "schema version 1"],
    ],
    decision: "Initial p95 budgets on the documented reference machine are: CLI help 750 ms cold; Manager ready 2.5 s cold; warm fake-provider run 250 ms; local event projection lag 100 ms; idle Gateway+Manager RSS 150 MiB and CPU below 1%; warm-image browser ready 8 s; owned-resource cleanup 5 s; snapshot throughput 50 MiB/s with peak working memory at most 128 MiB independent of archive size. Disabled packs consume zero processes, containers, sockets, network calls, and repeating timers.",
    alternatives: "One fake-provider sample as a product benchmark; averages without tail latency; budgets that ignore platform and artifact hashes.",
    security: "Resource ceilings and cleanup latency limit denial-of-service and orphan accumulation; zero-idle checks detect accidental background capability activation.",
    compatibility: "Budgets are platform-qualified and may be amended only with evidence and an ADR, not silently relaxed when tests regress.",
    migration: "Build repeatable cold/warm suites, record hardware/runtime/artifact hashes and sample distributions, run supported platforms, then replace provisional numbers with measured accepted thresholds.",
    release: "Provisional until statistically meaningful multi-platform evidence exists; regressions beyond accepted budgets block release.",
  },
  {
    number: 51, slug: "contract-status-and-amendment", title: "Architecture contract status and amendment process", status: "accepted", items: "Plan contradiction: freeze candidate versus final implementation",
    sources: [
      ["Architecture contract", "../../LITE_HARNESS_ARCHITECTURE_PLAN.md", "SHA-256 cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f"],
      ["Alpha requirement ledger", "../requirements/alpha-ledger.yaml", "schema version 1"],
    ],
    decision: "Treat the reviewed plan hash as the immutable architecture contract baseline, not proof that implementation is final. ADRs may clarify contradictions or supersede a decision; they never rewrite historical evidence. Every amendment names affected requirement IDs, migration, tests, and release impact. Generated status comes only from current ledger/evidence.",
    alternatives: "Editing the plan until it matches implementation; treating the plan as aspirational and non-binding; declaring completion from file existence.",
    security: "Immutable baseline plus explicit amendments prevents silent erosion of trust boundaries and release gates.",
    compatibility: "Contributors can distinguish baseline intent, accepted amendments, implementation status, and external blockers.",
    migration: "Link each requirement to ADR/code/test/CI/evidence, add an amendment index, and reject status changes lacking current production-path proof.",
    release: "The generated verdict may report a VERIFIED LOCAL ALPHA CANDIDATE when all locally actionable rows and defects have current evidence; unavailable platform, provider, naming, signing, and registry authorities remain explicitly blocked-external until their own evidence exists.",
  },
  {
    number: 52, slug: "alpha-scope-and-preview-boundaries", title: "Alpha scope, networking, services, and preview boundaries", status: "accepted", items: "Plan contradictions: networking, breadth, service managers, WebSocket, provider/integration tiers",
    sources: [
      ["Architecture contract", "../../LITE_HARNESS_ARCHITECTURE_PLAN.md", "reviewed baseline"],
      ["Alpha definition", "../requirements/alpha-ledger.yaml", "A01-A22"],
      ["MCP transports", "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports", "stdio and Streamable HTTP"],
      ["Codex app-server transports", "https://developers.openai.com/codex/app-server", "WebSocket experimental"],
    ],
    decision: "Core alpha includes compiled foreground launcher/Gateway/Manager, durable coordinator, SDKs, fake runtime, enforceable Docker tool boundary, OpenAI/OpenAI-compatible/Anthropic/Codex lanes only after conformance, stdio and Streamable HTTP MCP, managed browser only after brokered egress, snapshots/recovery, and compatibility migration. General-purpose brokered networking is not a standalone alpha API, but every alpha-enabled network capability must use enforceable broker policy. Broad providers, integrations, automation, vector memory, delegated Claude, OS service managers, and pxpipe are preview. WebSocket is not an alpha public surface; public control uses REST commands plus replayable SSE.",
    alternatives: "Counting preview breadth toward alpha; requiring every roadmap ecosystem item before core alpha; advertising WebSocket from unimplemented or experimental transports.",
    security: "No networked capability is promoted without enforceable egress/auth policy, and service/background claims cannot exceed tested lifecycle evidence.",
    compatibility: "REST+SSE, versioned IPC, and named core provider/MCP contracts are alpha surfaces. Preview packs are clearly labeled and excluded from A01-A22 evidence.",
    migration: "Remove WebSocket promises, relabel breadth consistently, gate browser/HTTP/MCP networking, keep service generation preview, and promote each pack only through its own conformance evidence.",
    release: "Resolves the plan contradictions without weakening A01-A22; missing core lanes still block verified alpha.",
  },
];

mkdirSync(outputDir, { recursive: true });
let stale = false;
for (const record of records) {
  const number = String(record.number).padStart(4, "0");
  const path = resolve(outputDir, `${number}-${record.slug}.md`);
  stale = compareOrWrite(path, render(record, number)) || stale;
}
stale = compareOrWrite(resolve(outputDir, "RESEARCH.md"), renderIndex()) || stale;

if (check && stale) {
  process.stderr.write("Research ADRs are stale; run pnpm generate:adrs:research.\n");
  process.exitCode = 1;
} else if (check) {
  process.stdout.write(`Research ADR checks passed for ${records.length} decisions.\n`);
} else {
  process.stdout.write(`Generated ${records.length} research and contradiction ADRs.\n`);
}

function compareOrWrite(path, content) {
  if (check) {
    try { return readFileSync(path, "utf8").replaceAll("\r\n", "\n") !== content; }
    catch { return true; }
  }
  writeFileSync(path, content);
  return false;
}

function render(record, number) {
  const sources = record.sources.map(([label, url, version]) => `- ${label}: ${url} (${version}; retrieved ${retrieved})`).join("\n");
  return `# ADR ${number}: ${record.title}\n\n` +
    `- Status: ${record.status}\n- Date: ${retrieved}\n- Covers: ${record.items}\n\n` +
    `## Primary sources\n\n${sources}\n\n` +
    `## Decision\n\n${record.decision}\n\n` +
    `## Alternatives considered\n\nRejected: ${record.alternatives}\n\n` +
    `## Security impact\n\n${record.security}\n\n` +
    `## Compatibility impact\n\n${record.compatibility}\n\n` +
    `## Migration plan\n\n${record.migration}\n\n` +
    `## Release impact\n\n${record.release}\n`;
}

function renderIndex() {
  const rows = records.map((record) => {
    const number = String(record.number).padStart(4, "0");
    return `| ${number} | [${record.title}](./${number}-${record.slug}.md) | ${record.status} | ${record.items} |`;
  }).join("\n");
  return `# Research and contradiction ADRs\n\n` +
    `These records use primary/official sources retrieved ${retrieved}. Provisional and blocked decisions remain release blockers until their stated evidence or owner input exists.\n\n` +
    `| ADR | Decision | Status | Covers |\n| --- | --- | --- | --- |\n${rows}\n`;
}
