# Implementation status

Date: 2026-07-14

## Implemented and verified

- Real GitHub-network fork with ancestry pinned to OpenClaw commit
  `834810b3d6e367cbdf69b4c822d220f1a150b14c`
- pnpm/TypeScript monorepo with strict dependency-boundary ratchet
- Separate Gateway and Manager roles with authenticated local IPC
- Durable SQLite agent profiles, workspaces, runs, attempts, sessions,
  messages, approvals, usage ledgers, idempotency, ordered event replay,
  cancellation, steering, and restart reconciliation
- Workspace/session serialization plus inherited per-run turn, tool, token,
  cost, total, model-idle, and command limits
- One-writer workspace leases with monotonic fencing tokens
- Provider core with model capability registry, credential broker, frozen route
  plans, typed retry/fallback, usage records, and redaction
- Direct fake, OpenAI-compatible, and Anthropic provider adapters
- Official Codex app-server and Claude Code delegated adapters over bounded,
  cancellable process seams with normalized text/usage events
- Digest-pinned Docker tool image and runtime with named volumes, non-root tool
  execution, no network, read-only root, dropped capabilities, resource limits,
  bounded output, binary export, staging restore, backup rollback, and cleanup
- AES-256-GCM workspace snapshots with content verification and previous-good
  fallback
- App/tenant/user-owned artifacts through Manager, Gateway, TypeScript SDK,
  and the brokered `artifact_publish` agent tool
- Manifest-first plugin permissions, atomic install lock, process Host RPC,
  health/crash-backoff/idle supervision, deterministic SKILL.md discovery, and
  process-backed MCP stdio supervision with discovery filters
- Monotonic agent tool allowlists enforced before runtime execution
- Reference optional packs for browser ownership/network policy, integration
  signature/dedupe, scheduler leases, subagent budgets/cancellation, offline
  FTS memory, and conservative exact-recoverable context rendering
- CLI doctor, snapshot key generation, workspace snapshot/restore/delete
- Public API/SDK docs, OpenAPI, threat model, recovery guide, provider/plugin
  guides, CI matrix, secret/provenance/release checks, and community files

## Verification evidence

- Clean pnpm install succeeds under the pinned pnpm 11.7.0 policy.
- Strict TypeScript and dependency boundaries pass.
- 50 credential-free unit/integration/security/conformance tests pass.
- The environment-gated real Docker test passed on Docker Desktop Linux/WSL2:
  create volume, write in a disposable container, export archive, mutate,
  staging/backup restore, read from a new container, and remove the volume.
- Secret exposure, provenance, repository structure, pinned-image, and OpenClaw
  ancestry checks pass.

Node's built-in `node:sqlite` still emits an experimental warning on Node 24.
It remains isolated behind storage ports; this is a release risk to resolve
before a stable 1.0 claim.

## Staged preview boundaries

The browser, integrations, automation, subagents, memory, skills, plugin,
and context packages currently provide secure contracts and tested reference
behavior. They are not claims of full OpenClaw ecosystem parity. In particular,
managed Chromium execution, Telegram/Discord/Slack workers, remote MCP HTTP,
and the quarantined OpenClaw compatibility worker remain preview work.

## Remaining before the complete architecture-plan claim

- OS-keychain credential and snapshot-key providers with refresh single-flight
- Streaming direct adapters plus live-account delegated-runtime conformance
- Published multi-architecture runtime images and Linux/macOS/Windows host matrix
- Staged plugin package copying, atomic upgrade rollback, and bounded OpenClaw
  compatibility worker
- Managed Chromium sidecar with stable refs, actions, downloads, screenshots,
  private-network/redirect enforcement, and profile isolation
- Production Web/API/webhook plus Telegram/Discord/Slack connectors and durable
  scheduler/receipt storage
- Durable subagent graphs and memory integration in the live Manager loop
- Measured pxpipe evaluation; it remains correctly disabled by default
- Installer/service management, SBOM, performance budgets, recovery drills,
  cross-platform real-machine alpha evidence, legacy deletion, and beta API labels

The repository is an honest architecture-complete foundation and working alpha
spine, not yet the months-long feature-complete ecosystem described by every
phase of the full roadmap.
