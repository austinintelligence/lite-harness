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
  plans, typed retry/fallback, single-flight credential refresh, usage records,
  redaction, and OS-backed secret profiles
- Streaming fake, OpenAI-compatible, Anthropic, OpenRouter, Gemini, xAI,
  Moonshot/Kimi, and MiniMax routes through normalized provider contracts
- Official Codex app-server and Claude Code delegated adapters over bounded,
  cancellable process seams with normalized text/usage events
- Digest-pinned Docker tool image and runtime with named volumes, non-root tool
  execution, no network, read-only root, dropped capabilities, resource limits,
  bounded output, binary export, staging restore, backup rollback, and cleanup
- Gzip plus AES-256-GCM workspace snapshots with content verification,
  previous-good fallback, load-aware compaction, managed volumes, and explicit
  registered-bind workspaces
- App/tenant/user-owned artifacts through Manager, Gateway, TypeScript SDK,
  and the brokered `artifact_publish` agent tool
- Manifest-first plugin permissions, staged digest-verified install/rollback,
  process Host RPC, bounded OpenClaw compatibility worker, CLI lifecycle,
  health/crash-backoff/idle supervision, deterministic SKILL.md discovery, and
  process-backed MCP stdio plus brokered remote-HTTP supervision
- Monotonic agent tool allowlists enforced before runtime execution
- Managed Chromium sidecar with digest-pinned reproducible image, non-root
  process, broker-fetched DNS/IP-pinned HTTP(S), bounded resources/artifacts,
  lazy owner-scoped sessions, encrypted owner profiles, remote-CDP mode, stable
  element refs, tab/dialog/network/console actions, audit, and idle teardown
- Durable signed webhook ingress and binding/receipt/dedupe storage, native
  Telegram/Discord/Slack verification, fixed-origin outbound adapters, durable
  leased reply delivery, attachment references, and signed app callbacks
- Opt-in durable interval/one-shot/daily automation with IANA time zones, DST
  handling, leases, deterministic jitter, firing history, missed-run policy,
  restart preservation, retry, and idempotent run keys
- Live Manager tools for durable subagent graphs and offline FTS memory, plus
  removable vector-memory ABI and conservative exact-recoverable pxpipe context
- CLI doctor/service/plugin/migration commands, snapshot key generation,
  workspace register/snapshot/restore/delete, rotating redacted logs, Linux
  systemd and macOS launchd definitions, and a unified launcher
- TypeScript and Python prerelease SDKs
- Public API/SDK docs, OpenAPI, threat model, recovery/migration/operations
  guides, cross-platform CI and image workflows, SBOM generation,
  secret/provenance/release checks, and community files

## Verification evidence

- Clean pnpm install succeeds under the pinned pnpm 11.7.0 policy.
- Strict TypeScript and dependency boundaries pass.
- The final test count is recorded by the release check rather than frozen in
  this document as the suite grows.
- The environment-gated real Docker test passed on Docker Desktop Linux/WSL2:
  create volume, write in a disposable container, export archive, mutate,
  staging/backup restore, read from a new container, and remove the volume.
- The pinned browser image built on Docker Desktop/WSL2 and its real Chromium
  integration navigated, snapshotted stable content, shut down, and left zero
  running browser containers. Verified local image ID:
  `sha256:d5995205a367760808aeff18b5d228ad12b9e83c3a71c7835cdaaaa35253f924`.
- Secret exposure, provenance, repository structure, pinned-image, and OpenClaw
  ancestry checks pass.
- A local Hermes-backed inference traversed the real OpenAI-compatible adapter
  using `gpt-5.6-luna`; no upstream OAuth credential entered the repository.
- The checked-in pxpipe report verifies exact recovery and keeps rendering
  disabled by default because no model-quality benefit has been established.
- The checked-in kernel benchmark records startup, run latency, and both
  process RSS measurements on Windows x64.

Node's built-in `node:sqlite` still emits an experimental warning on Node 24.
It remains isolated behind storage ports; this is a release risk to resolve
before a stable 1.0 claim.

## Support boundary and external evidence

The Lite-owned architecture and alpha roadmap are implemented. Optional packs
remain explicit support tiers rather than a promise that every OpenClaw plugin
or connector is native. Telegram/Discord/Slack include conformance-tested
verification and delivery adapters; long-running polling/socket transports are
deployment-specific workers, not always-on core services. Human noVNC and
host-session browser attachment remain intentionally deferred high-trust UX.

Repository automation covers Linux, macOS, Windows, amd64/arm64 image builds,
dependency auditing, and SBOM generation. Evidence that cannot be manufactured
inside one Windows checkout remains an external release gate: completed remote
CI jobs, real macOS/Linux Docker and rootless-Docker runs, provider/delegated
accounts not supplied by the operator, registry image publication, and a
stabilization period before beta. The API and SDK therefore remain
`0.1.0-alpha.0`; private package flags prevent accidental publication.
