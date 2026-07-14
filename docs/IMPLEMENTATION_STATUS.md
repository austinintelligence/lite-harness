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
- Managed Chromium sidecar with digest-pinned reproducible image, non-root
  process, bounded resources/artifacts, lazy owner-scoped sessions, stable
  element refs, typed actions, downloads/uploads, audit, and idle teardown
- Durable signed webhook ingress and binding/receipt/dedupe storage, native
  Telegram/Discord/Slack verification and fixed-origin outbound adapters
- Opt-in durable interval/one-shot automation with leases, deterministic
  jitter, firing history, restart preservation, retry, and idempotent run keys
- Reference optional packs for subagent budgets/cancellation, offline FTS
  memory, and conservative exact-recoverable context rendering
- CLI doctor, snapshot key generation, workspace snapshot/restore/delete
- Public API/SDK docs, OpenAPI, threat model, recovery guide, provider/plugin
  guides, CI matrix, secret/provenance/release checks, and community files

## Verification evidence

- Clean pnpm install succeeds under the pinned pnpm 11.7.0 policy.
- Strict TypeScript and dependency boundaries pass.
- 57 credential-free unit/integration/security/conformance tests pass.
- The environment-gated real Docker test passed on Docker Desktop Linux/WSL2:
  create volume, write in a disposable container, export archive, mutate,
  staging/backup restore, read from a new container, and remove the volume.
- The pinned browser image built on Docker Desktop/WSL2 and its real Chromium
  integration navigated, snapshotted stable content, shut down, and left zero
  running browser containers. Verified local image ID:
  `sha256:af820e2cfeb4648d23663a486391750c5180693555fc716d1cfd8c4954823851`.
- Secret exposure, provenance, repository structure, pinned-image, and OpenClaw
  ancestry checks pass.

Node's built-in `node:sqlite` still emits an experimental warning on Node 24.
It remains isolated behind storage ports; this is a release risk to resolve
before a stable 1.0 claim.

## Staged preview boundaries

The browser, integrations, automation, subagents, memory, skills, plugin, and
context packages are staged alpha capabilities, not claims of full OpenClaw
ecosystem parity. Managed Chromium is operational; strict DNS-rebinding
resistance still requires a brokered egress proxy rather than route-time DNS
checks. Telegram/Discord/Slack polling or socket workers, remote MCP HTTP, and
the quarantined OpenClaw compatibility worker remain preview work.

## Remaining before the complete architecture-plan claim

- OS-keychain credential and snapshot-key providers with refresh single-flight
- Streaming direct adapters plus live-account delegated-runtime conformance
- Published multi-architecture runtime images and Linux/macOS/Windows host matrix
- Staged plugin package copying, atomic upgrade rollback, and bounded OpenClaw
  compatibility worker
- Brokered browser egress, remote-CDP conformance, persistent encrypted browser
  profiles, and cross-platform recorded-task evidence
- Live Telegram/Discord/Slack polling/socket workers, connector reply delivery,
  attachments, approvals, schedule time zones, and missed-run policies
- Durable subagent graphs and memory integration in the live Manager loop
- Measured pxpipe evaluation; it remains correctly disabled by default
- Installer/service management, SBOM, performance budgets, recovery drills,
  cross-platform real-machine alpha evidence, legacy deletion, and beta API labels

The repository is an honest architecture-complete foundation and working alpha
spine, not yet the months-long feature-complete ecosystem described by every
phase of the full roadmap.
