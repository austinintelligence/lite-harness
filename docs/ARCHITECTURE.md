# Architecture

> **NOT YET A VERIFIED ALPHA.** This document describes the contracted target
> architecture and partially integrated call paths. It is not evidence that a
> capability or platform is release-supported. Current proof and blockers are
> generated in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) and
> [../BLOCKERS.md](../BLOCKERS.md).

Lite-Harness keeps five durable concepts separate: Agent, Session, Workspace,
Run, and Runtime. A container is never the owner of conversation or workspace
state.

## Dependency direction

`contracts -> domain/provider/runtime ports -> control-plane services -> adapters -> apps`

Gateway depends only on public contracts. Manager is the composition root for
SQLite, provider adapters, plugins, artifacts, and Docker. Optional packs do
not appear in the Manager import graph until enabled.

## Run lifecycle

1. Gateway authenticates the app token and derives app/tenant/user identity.
2. Manager atomically creates or replays an idempotent run and session message.
3. The run queues, acquires a fenced workspace lease, and starts Agent Runtime.
4. Provider Plane freezes a capability-compatible route; Manager commits the
   complete immutable `RunSnapshot`; only then may the first model turn begin.
5. Tool calls pass policy/approval and execute in a bounded Docker container.
6. Every event receives the next durable per-run sequence number.
7. The runtime container disappears; the named volume, session, and events remain.
8. Manager restart marks interrupted attempts `ORPHANED` with retry guidance.

## Immutable run boundary

Every attempt has one content-digested SQLite `RunSnapshot`. It contains the
exact agent profile and budget, advertised tool schemas, eligible skill
digests, enabled plugin versions and package digests, durable provider route,
runtime image/profile policy, network-policy digest, and credential profile
IDs. It contains identifiers rather than credential values. A second write may
only be an exact idempotent replay; any changed field fails closed.

Agent Runtime awaits this commit after route and context preparation and before
calling the provider stream. Configuration changes therefore affect a later
attempt, never an already-prepared attempt.

## Observability boundary

Gateway and Manager requests start a bounded trace, return its opaque ID in
`X-Lite-Trace-Id`, and finish with structured request metrics and an audit
event. The RunService coordinator reports accepted/replayed runs, queue wait,
workspace lease acquisition, and terminal outcomes through a kernel-owned
observability port so the durable execution lifecycle is covered as well. All
telemetry calls are fail-open to the run path: a broken sink cannot change run
state. `StructuredObservability` accepts only finite bounded metric values and
sanitizes attributes before retaining them in a bounded in-memory ring or a
mode-600 JSONL sink. Prompt, file, path, stack, and credential fields are
omitted or redacted by default; the sink is telemetry and audit evidence, not a
storage path for user content.

## Approval boundary

Each pending approval stores a SHA-256 execution digest over the exact tool and
canonical argument digest, run, app/tenant/user owner, workspace, agent-policy
version, provider-route generation, and expiry. The Manager revalidates that
binding both when a decision is resolved and immediately before the tool
runtime mutation boundary. Route or policy drift, changed arguments, and
expired decisions fail closed and require a new approval.

Before an approval is requested, Agent Runtime validates the call against the
exact JSON Schema advertised for that tool in the current model turn. Invalid,
unadvertised, or ambiguously duplicated tools fail before approval and runtime
dispatch; validation never coerces, removes, or defaults model-supplied values.

## Wire-contract boundary

Public REST and local Gateway-to-Manager bodies reuse the authoritative TypeBox
schemas exported by `@lite-harness/contracts`. The internal schemas are tied to
the required IPC protocol header and reject unknown properties, malformed
principals, out-of-range budgets, invalid modes, and malformed artifact data
before a control-plane or storage method runs. OpenAPI is generated from the
same public schemas.

## Optional packs

Plugins, skills, MCP, browser, connectors, schedules, subagents, memory, and
context rendering are versioned boundaries. Disabled packs instantiate no
worker, timer, socket, or tool schema. Skills are data snapshots and cannot
grant themselves tools. Third-party plugins are isolated by default and can
only receive operator-granted subsets of declared permissions.

## Fork strategy

The Lite branch descends from the pinned OpenClaw commit. Compatibility remains
an adapter and migration lane; no production package may import a
`legacy/openclaw` path. Behavior fixtures, not file similarity, decide parity.
