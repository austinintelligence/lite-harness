# Lite-Harness Python and Hermes Rebuild Blueprint

Status: architecture and execution proposal  
Date: 2026-07-24  
Lite-Harness baseline: `lite-main` at `4ac6bc1d3e37524e7e689f1e8a818c5bd7743b75`  
Hermes baseline: `v2026.7.20` at `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`  
Target Python: CPython 3.12, while retaining compatibility with the Hermes-supported `>=3.11,<3.14` interval  
Decision posture: proposal until the characterization, storage compatibility, security, and differential-execution gates pass

## 1. Executive decision

Lite-Harness should not be replaced by a direct copy of Hermes Agent, and its Git history should not be force-rebased or discarded.

The recommended rebuild is a controlled strangler migration with three implementation layers:

1. **Python control plane** for Gateway, Manager, persistence, policy, orchestration, SDK generation, operations, and most optional systems.
2. **Pinned Hermes engine workers** for agent-loop behavior, provider compatibility, reasoning streams, prompt assembly, selected skills, and selected memory behavior.
3. **Native acceleration only where benchmarks prove it is needed**, using existing native dependencies or a small Rust extension for isolated hot paths. Python is selected for ecosystem alignment and implementation leverage, not because CPython is generally faster than Node.js for CPU-bound work.

The durable Lite-Harness model remains authoritative. Lite-Harness owns identity, authorization, run state, idempotency, event sequence, workspace leases, fencing, budgets, approvals, artifacts, snapshots, cleanup, and delivery obligations. Hermes is an execution engine behind a versioned protocol. It must not become a second control plane with competing run IDs, credentials, persistence, or policy.

The migration is complete only when production paths contain no TypeScript implementation dependency, every current alpha invariant has equivalent or stronger evidence, external platform and provider lanes are qualified, upgrade and rollback are proven, and the old implementation is removable without changing the public API.

## 2. Why a big-bang rewrite would be the wrong first move

The current repository is already a meaningful platform. It has a separate network-facing Gateway and privileged Manager, durable SQLite run and event records, replayable streams, idempotency, cancellation, steering, workspace fencing, Docker containment, encrypted snapshots, artifact ownership, provider routing, plugins, skills, MCP, browser automation, integrations, subagents, memory, release evidence, and a generated requirement ledger.

The current generated status identifies a verified Windows-local alpha with no locally actionable critical or high release blocker. Two alpha rows remain externally blocked: broader platform qualification and live provider conformance. The roadmap-exit ledger still lacks full traceability, so the code is not equivalent to a finished cross-platform beta, but it is far beyond a disposable prototype.

A direct rewrite would simultaneously risk:

- public API drift;
- lost event-ordering and replay semantics;
- SQLite migration corruption;
- workspace split-brain writes;
- lost provider usage and pricing provenance;
- weaker cancellation and process reaping;
- secret leakage through subprocess environments;
- policy widening by tools, skills, or plugins;
- duplicated persistence between Lite-Harness and Hermes;
- unbounded upstream divergence from Hermes;
- a long interval where neither implementation is trustworthy.

The migration therefore uses preserved contracts, differential execution, feature-gated cutovers, and reversible schema additions.

## 3. Non-negotiable architecture invariants

The rebuild must preserve or strengthen the following invariants before any cutover:

1. Gateway remains network-facing and cannot control Docker directly.
2. Manager remains the privileged local authority and communicates with Gateway through protected local IPC.
3. Public authorization is scoped by app, tenant, user, resource, and action.
4. Unauthorized resource lookup does not become an enumeration oracle.
5. Durable run state is committed independently of process lifetime.
6. Every run event has a strictly increasing per-run sequence number.
7. Event replay resumes from an explicit cursor without rerunning work.
8. Run creation is idempotent within its owner scope and rejects key reuse with different content.
9. One writable run owns a workspace at a time.
10. Workspace ownership uses monotonic fencing tokens so stale writers cannot commit.
11. General tool and browser containers receive no Docker socket and no permanent model credential.
12. Docker runtime profiles use immutable image identity, non-root execution, a read-only root, dropped capabilities, no-new-privileges, and resource limits.
13. A policy decision can only narrow authority. Skills, plugins, prompts, and engines cannot widen it.
14. Provider fallback stops after an externally visible side effect unless the operation has an explicit idempotency proof.
15. Snapshot ciphertext is authenticated before restore and a previous verified generation remains available.
16. Artifacts are owner-scoped, size-bounded, hashed, and promoted through a controlled boundary.
17. Browser egress rejects private, link-local, metadata, credential-bearing, and non-allowlisted destinations.
18. Provider secrets never become run-state fields, prompt text, Gateway state, or ordinary tool-container environment variables.
19. A disabled optional pack starts no process, timer, socket, or import-time side effect.
20. Cancellation either proves worker and child-process cleanup or records cleanup debt for reconciliation.
21. Billing and usage remain unknown when the provider does not report authoritative data. Missing telemetry must never be rewritten as zero.
22. Release claims come from current, zero-skip evidence tied to the exact candidate commit.

These invariants are the migration constitution. A faster implementation that violates them is a regression.

## 4. Target architecture

```text
                        External apps and users
                                  |
                    REST, SSE, WebSocket, SDKs
                                  |
                    +-------------------------+
                    | Python Lite Gateway     |
                    | auth, scopes, rate caps |
                    | outward event delivery  |
                    +------------+------------+
                                 |
                       protected local IPC
                                 |
                    +------------v------------+
                    | Python Harness Manager  |
                    | durable run coordinator |
                    | policy and budget owner |
                    | workspace lease owner   |
                    +---+----------+----------+
                        |          |
        engine protocol |          | capability protocols
                        |          |
           +------------v--+   +---v----------------------+
           | Hermes workers |   | runtime/plugin/browser  |
           | one run or      |   | workers and containers |
           | isolated slot   |   | narrow brokered access |
           +--------+--------+   +--------------------------+
                    |
       provider APIs, delegated runtimes, local endpoints

          SQLite event log, state, snapshots, artifacts
                    remain Lite-owned
```

### 4.1 Process roles

#### Python Gateway

Owns:

- public HTTP and streaming protocols;
- authentication and token issuance;
- principal resolution;
- rate limiting and request-size limits;
- public schema validation;
- idempotency-key transport;
- event replay delivery;
- OpenAPI publication;
- health and readiness projection;
- optional compatibility endpoints.

Does not own:

- Docker access;
- provider secret material;
- workspace encryption keys;
- direct host filesystem execution;
- Hermes instance state;
- plugin code loading.

#### Python Manager

Owns:

- run state machine;
- queueing and concurrency;
- workspace leases and fencing;
- budget enforcement;
- approvals and policy;
- durable event sequencing;
- engine-worker lifecycle;
- tool-runtime brokering;
- checkpoint and restore orchestration;
- reconciliation after crash;
- model-route and usage records;
- artifact promotion;
- shutdown and cleanup debt.

#### Hermes engine worker

Owns only the execution semantics delegated for one authorized operation:

- prompt assembly selected by the engine profile;
- model request and response adaptation;
- reasoning and text streaming;
- agent-loop progression;
- provider-specific retry classification;
- selected context compression behavior;
- selected skill rendering;
- selected model metadata and routing support.

The worker does not own the canonical run record, public event cursor, workspace lease, external delivery, long-lived provider secret, Docker socket, root snapshot key, or Manager database.

#### Runtime and capability workers

Tool execution, plugins, MCP, browser work, and connectors remain behind explicit capability brokers. Hermes requests tools through the engine protocol. Manager decides whether the tool was advertised, allowed, approved, budgeted, and still protected by an active fencing token.

## 5. Ownership matrix

| Concern | Lite-Harness authority | Hermes contribution | Rule |
| --- | --- | --- | --- |
| App, tenant, user auth | Gateway and Manager | none | Hermes never sees public bearer tokens |
| Run ID and idempotency | Manager and SQLite | task correlation only | Hermes IDs are metadata, never public identity |
| Session transcript | Lite durable store | engine-compatible view | one canonical transcript, no silent dual writes |
| Event sequence | Lite event log | emits unsequenced engine events | Manager assigns sequence transactionally |
| Workspace | Manager/runtime | receives scoped working directory or broker calls | no lease authority in Hermes |
| Tool policy | Manager | may classify risk or request approval | Lite decision is final and monotonic |
| Provider route | Lite policy and connection record | provider adapter and model metadata | selected route is frozen in run snapshot |
| Provider credential | Lite credential broker | ephemeral operation-scoped use | never persisted by worker |
| Usage and cost | Lite ledger | normalized usage evidence | unknown remains unknown |
| Skills | Lite snapshot and policy | Hermes rendering or execution adapter | immutable per-run digest list |
| Memory | Lite owner-scoped store | optional Hermes memory interface | no implicit global home-directory memory |
| Subagents | Lite parent-child graph | Hermes delegation semantics | child budget and authority are subsets |
| Integration delivery | Lite delivery ledger | response content | final delivery is durable and idempotent |
| Updates | Lite release policy | pinned Hermes package | upstream change requires conformance and migration review |

## 6. Hermes integration strategy

### 6.1 Pinning

The first supported engine distribution is exactly:

```text
Tag: v2026.7.20
Commit: 3ef6bbd201263d354fd83ec55b3c306ded2eb72a
Package version: 0.19.0
```

The dependency lock must include the tag, commit, resolved wheel or source digest, license, and complete transitive lock. Runtime diagnostics must expose the exact engine version and digest. A mutable branch or unpinned Git dependency is not allowed in release artifacts.

### 6.2 Do not embed a shared AIAgent instance

Hermes documents `AIAgent` as stateful and not safe to share across concurrent tasks. Its agent loop also includes substantial process-global, environment, tool, session, and callback behavior. The first production integration must therefore be process-isolated.

Recommended worker models:

1. **Per-run worker**, simplest and strongest isolation, acceptable for correctness-first migration.
2. **Prewarmed single-run slot**, a process remains warm but executes one run at a time and is reset or recycled after bounded use.
3. **Small profile pool**, only after reset correctness, secret hygiene, memory isolation, and cancellation have evidence.

A shared in-process singleton is forbidden.

### 6.3 Bootstrap adapter choices

There are two useful adapters, in this order:

#### Adapter A: Hermes HTTP reference adapter

Hermes exposes run creation, run status, SSE events, approval, stop, and health endpoints. Use this adapter only to build conformance fixtures and validate event semantics quickly. It is not the desired final topology because it creates a second run controller and a second persistence layer.

#### Adapter B: Direct Hermes worker adapter

A dedicated Python worker imports the pinned Hermes package and runs one isolated agent operation. Lite-Harness provides:

- canonical messages;
- immutable tool definitions;
- allowed tool names;
- route and model configuration;
- scoped ephemeral credentials;
- run, attempt, workspace, and fencing metadata;
- budget limits;
- callback endpoints over the local engine protocol.

Hermes provides streamed engine events. Tool requests are returned to Manager, executed through Lite policy and runtime, and sent back as tool results. This adapter is the production target.

### 6.4 Progressive Hermes adoption

Do not activate every Hermes subsystem at once.

1. Agent loop and provider stream normalization.
2. Reasoning events and provider error classification.
3. Prompt builder and model metadata.
4. Context compression under immutable run configuration.
5. Skills rendering from Lite-owned snapshots.
6. Selected memory provider adapter against Lite-owned storage.
7. Selected delegated runtimes.
8. Optional Hermes-native capabilities only when they do not duplicate Lite authority.

Hermes gateway routing, direct delivery, canonical session persistence, broad environment passthrough, and unrestricted tool registry remain disabled inside Lite workers.

## 7. Engine protocol

The repository already has a bounded JSON-line process RPC implementation with timeouts, cancellation, output caps, environment construction, and process reaping. Use a language-neutral successor to that transport for the first engine protocol.

### 7.1 Framing

- JSON-RPC 2.0 over stdin/stdout for phase one.
- UTF-8, one message per line.
- Maximum frame size enforced on both sides.
- stderr is diagnostic only, bounded and redacted.
- stdout must contain protocol frames only.
- Protocol version negotiated in the first handshake.
- Every request includes run ID, attempt ID, and an operation nonce.
- Unknown notification types are journaled but do not crash the Manager.
- Unknown required capabilities fail closed.

A binary transport can be evaluated later. It is not needed before measurements show JSON framing is material.

### 7.2 Manager-to-worker methods

```text
engine.handshake
engine.describe
run.prepare
run.start
run.cancel
run.steer
tool.result
approval.result
context.append
run.shutdown
engine.ping
```

### 7.3 Worker-to-Manager requests

```text
tool.execute
approval.request
artifact.publish
context.fetch_exact
memory.search
memory.write
subagent.start
subagent.wait
secret.resolve_operation_scope
```

Every worker-to-Manager method has an explicit capability requirement and owner scope. The worker cannot ask for an arbitrary host path, process environment, Docker option, database query, credential name, or network destination.

### 7.4 Notifications

```text
engine.ready
agent.text.delta
agent.reasoning.delta
agent.message.completed
tool.call.requested
tool.call.progress
tool.call.completed
usage.reported
route.selected
status.changed
warning.emitted
engine.heartbeat
run.completed
run.failed
```

### 7.5 Canonical event mapping

Hermes events are normalized into existing Lite run events wherever possible:

| Hermes event | Lite event |
| --- | --- |
| text delta | `agent.message.delta` |
| completed assistant message | `agent.message.completed` |
| tool request | `tool.call.requested` |
| tool result | `tool.call.completed` |
| usage | `usage.updated` |
| approval request | `approval.requested` |
| final success | `run.succeeded` |
| final failure | `run.failed` |
| cancellation | `run.cancelled` |

Additive v1 events may be introduced for reasoning, status, warning, and engine lifecycle only after the OpenAPI and SDK compatibility policy is defined. Until then, store them in an engine-event side journal and expose them through optional metadata without breaking strict clients.

Every normalized event includes provenance fields internally:

```json
{
  "engine": "hermes",
  "engineVersion": "0.19.0",
  "engineCommit": "3ef6bbd201263d354fd83ec55b3c306ded2eb72a",
  "engineEventType": "...",
  "engineEventId": "..."
}
```

Manager assigns the public sequence in the same transaction that appends the event and updates the run cursor.

## 8. Data model migration

The existing schema is the starting point, not disposable ballast. Add forward-only migrations and keep old readers working during the dual-stack interval.

### 8.1 Proposed tables

#### `engine_installations`

- `id`
- `kind`
- `version`
- `commit_sha`
- `artifact_digest`
- `protocol_min`
- `protocol_max`
- `capabilities_json`
- `enabled`
- `created_at`

#### `run_engine_bindings`

- `run_id`
- `attempt_id`
- `engine_installation_id`
- `engine_profile_id`
- `engine_config_digest`
- `engine_session_id`
- `worker_instance_id`
- `started_at`
- `ended_at`
- `exit_code`
- `terminal_reason`

#### `engine_event_journal`

- `run_id`
- `attempt_id`
- `engine_event_index`
- `engine_event_type`
- `payload_json`
- `payload_digest`
- `received_at`
- `normalized_sequence`

This journal supports differential debugging without making engine payloads the public API.

#### `delivery_obligations`

- `id`
- `run_id`
- `integration_account_id`
- `conversation_key`
- `payload_digest`
- `status`
- `attempt_count`
- `next_attempt_at`
- `created_at`
- `delivered_at`

This closes the gap between a successful run and confirmed external delivery.

#### `cleanup_debt`

- `id`
- `kind`
- `resource_identity`
- `owner_run_id`
- `attempt_count`
- `last_error_code`
- `next_attempt_at`
- `created_at`
- `resolved_at`

#### `secret_resolution_audit`

Stores provenance and outcome only, never secret content:

- credential profile ID;
- secret-source kind;
- operation scope;
- worker ID;
- outcome;
- timestamps.

### 8.2 Transcript policy

Lite-Harness stores the canonical transcript. Hermes receives a materialized view and returns proposed additions. Manager validates and commits those additions.

Hermes-internal synthetic recovery messages, hidden scaffolding, private reasoning payloads, and transport metadata must not automatically enter the durable public transcript. A schema-controlled classifier decides what becomes:

- canonical message content;
- public run event;
- private engine journal data;
- discarded ephemeral state.

### 8.3 Migration properties

Every migration must be:

- forward-only in release builds;
- transactional where SQLite permits;
- restart-safe;
- idempotent;
- testable against a copy of every supported prior schema;
- accompanied by backup and restore evidence;
- compatible with the rollback window.

Before the final cutover, the Python implementation must open a copied TypeScript-era database, run migrations, replay existing events, preserve unknown usage as unknown, restore a workspace, and complete a new run.

## 9. Target repository layout

```text
lite-harness/
├── pyproject.toml
├── uv.lock
├── README.md
├── src/lite_harness/
│   ├── __init__.py
│   ├── contracts/
│   │   ├── models.py
│   │   ├── errors.py
│   │   ├── events.py
│   │   ├── jsonschema.py
│   │   └── openapi.py
│   ├── gateway/
│   │   ├── app.py
│   │   ├── auth.py
│   │   ├── dependencies.py
│   │   ├── routes/
│   │   ├── sse.py
│   │   └── manager_client.py
│   ├── manager/
│   │   ├── app.py
│   │   ├── coordinator.py
│   │   ├── scheduler.py
│   │   ├── reconciliation.py
│   │   └── shutdown.py
│   ├── engine/
│   │   ├── protocol.py
│   │   ├── supervisor.py
│   │   ├── fake.py
│   │   └── hermes/
│   │       ├── adapter.py
│   │       ├── worker.py
│   │       ├── event_mapper.py
│   │       ├── prompt_policy.py
│   │       └── version.py
│   ├── control_plane/
│   │   ├── runs.py
│   │   ├── state_machine.py
│   │   ├── queues.py
│   │   ├── approvals.py
│   │   └── subagents.py
│   ├── storage/
│   │   ├── sqlite.py
│   │   ├── transactions.py
│   │   ├── migrations/
│   │   └── repositories/
│   ├── policy/
│   ├── credentials/
│   ├── runtime/
│   ├── workspace/
│   ├── artifacts/
│   ├── plugins/
│   ├── skills/
│   ├── mcp/
│   ├── browser/
│   ├── integrations/
│   ├── automation/
│   ├── memory/
│   ├── observability/
│   ├── operations/
│   └── cli/
├── sdk/
│   ├── python/
│   └── typescript/
├── native/
│   └── lite_native/             # optional Rust extension after profiling
├── legacy/
│   └── typescript/              # temporary, removed at final gate
├── schemas/
│   ├── public/
│   ├── internal/
│   └── engine/
├── tests/
│   ├── unit/
│   ├── contracts/
│   ├── characterization/
│   ├── differential/
│   ├── integration/
│   ├── security/
│   ├── chaos/
│   ├── performance/
│   ├── upgrade/
│   └── qualification/
├── tools/
├── docs/
└── .github/workflows/
```

During migration, current `apps/`, `packages/`, `plugins/`, and Node scripts stay in place. They move under `legacy/typescript/` only after path-based imports, build scripts, fixtures, and provenance tooling can tolerate the move.

## 10. Python technical stack

### 10.1 Runtime and packaging

- CPython 3.12 as the primary release runtime.
- `uv` for interpreter selection, environment creation, locking, and workspace commands.
- One exact lock for release artifacts.
- PEP 621 metadata in the root `pyproject.toml`.
- Wheels for the application and SDK.
- Reproducible source archive with SBOM and provenance.

### 10.2 API and concurrency

- FastAPI for public schema-aware HTTP.
- Uvicorn for ASGI serving.
- AnyIO for structured concurrency and cross-platform cancellation.
- Separate Gateway and Manager processes.
- Unix domain sockets on Linux and macOS.
- Named pipes or loopback with protected token and ownership checks on Windows, selected only after parity tests.
- No Celery, Redis, Kafka, or distributed scheduler in the local release.

### 10.3 Contracts

- Pydantic v2 models or frozen dataclasses plus a strict schema layer.
- JSON Schema as the language-neutral contract source.
- OpenAPI generated from the same models validated at runtime.
- TypeScript and Python SDKs generated and then wrapped with hand-written ergonomic clients.
- Additional properties rejected on security-sensitive request models.
- Explicit numeric bounds, byte bounds, and recursion bounds.

### 10.4 SQLite

Start with the standard `sqlite3` module behind an explicit transaction and repository layer. Evaluate APSW only if concurrency, backup, or low-level SQLite behavior cannot be expressed safely with the standard driver.

Required settings and behavior:

- WAL mode;
- busy timeout;
- foreign keys enabled;
- synchronous policy recorded and tested;
- explicit transaction boundaries;
- no ORM-generated hidden schema changes;
- schema version and migration checksum;
- deterministic backup and restore;
- write serialization where required;
- bounded read pools only after thread-affinity tests.

### 10.5 Quality tooling

- pytest;
- pytest-asyncio or AnyIO pytest integration;
- Hypothesis for state machines and data invariants;
- Ruff for lint and format;
- `ty`, Pyright, or mypy selected by a written decision after a representative strictness trial;
- pip-audit or equivalent dependency scanning;
- Bandit only as a supplemental signal, never as the security proof;
- OpenTelemetry-compatible traces and structured JSON logs;
- deterministic clocks and ID sources in tests.

### 10.6 Native acceleration policy

Do not begin by rewriting Python orchestration in Rust. First profile real workloads.

Candidates for native acceleration only after measurement:

- streaming authenticated encryption;
- zstd compression;
- high-volume JSON validation or serialization;
- event-frame parsing;
- content hashing over large artifacts;
- filesystem tree scanning;
- CPU-heavy policy matching;
- terminal process-tree control on Windows.

Prefer mature existing native wheels before creating a custom extension. A custom Rust module must have a pure-Python fallback where practical, stable wheels for supported platforms, fuzz tests, and a narrowly defined API.

## 11. Migration phases and gates

No phase is considered complete because files were translated. Each phase ends with an executable proof.

### Phase 0: Freeze and provenance

Deliverables:

- record exact Lite and Hermes SHAs;
- add this blueprint and architecture decision records;
- tag the current TypeScript alpha baseline;
- create a protected legacy baseline branch;
- inventory licenses and third-party code;
- freeze public API v1, internal IPC v1, SQLite schema 16, event types, and current environment keys;
- define unsupported and externally blocked claims precisely;
- capture current benchmark and evidence artifacts.

Exit gate:

- a clean checkout can reproduce the current deterministic verification and benchmark lanes;
- every preserved behavior has a characterization test ID or an explicit removal decision;
- no rewrite branch can silently edit baseline evidence.

Rollback:

- discard the planning branch; `lite-main` remains unchanged.

### Phase 1: Behavior inventory and characterization corpus

Deliverables:

- enumerate public routes and SDK methods;
- enumerate run state transitions;
- enumerate event ordering and payload rules;
- enumerate SQLite tables, indexes, triggers, and migration behavior;
- record approval, cancellation, timeout, retry, fallback, replay, artifact, snapshot, plugin, browser, integration, subagent, and recovery traces;
- create golden JSON fixtures from deterministic fake-provider runs;
- create failure traces for truncated streams, missing usage, duplicate requests, stale leases, worker crashes, Docker restart, disk full, corrupt snapshots, and denied tools.

Exit gate:

- fixtures replay without network access;
- every current alpha gate maps to at least one characterization test;
- normalized fixtures contain no secret, absolute runner path, or unstable timestamp.

Rollback:

- fixtures are additive and do not alter production.

### Phase 2: Language-neutral contract kernel

Deliverables:

- move public and internal schemas into versioned JSON Schema files;
- generate TypeScript validators matching current behavior;
- generate Python models matching current behavior;
- add schema-differential tests against the current TypeBox validators;
- generate OpenAPI and compare operation IDs, paths, methods, required fields, bounds, and response shapes;
- define additive and breaking-change policy.

Exit gate:

- the Python and TypeScript validators agree over a large Hypothesis-generated corpus;
- current SDK contract-coverage tests pass against generated inventory;
- the public OpenAPI diff is empty except for documented metadata changes.

Rollback:

- TypeBox remains the production validator until this gate passes.

### Phase 3: Python workspace and deterministic fake slice

Deliverables:

- root Python workspace and exact lock;
- Python configuration loader with explicit environment mapping;
- structured errors and logging;
- health and readiness models;
- fake engine;
- in-memory tool runtime;
- minimal Python Gateway and Manager processes;
- protected local IPC;
- one run from acceptance to terminal success;
- replayable event stream;
- process shutdown tests on Windows, Linux, and macOS.

Exit gate:

- a Python-only fake run produces the same canonical trace as the TypeScript fixture;
- Manager and Gateway are separate processes;
- Manager restart reconciles a deliberately interrupted fake run;
- a second Manager is rejected.

Rollback:

- Python entry points are opt-in and do not replace package scripts.

### Phase 4: SQLite compatibility layer

Deliverables:

- Python repositories for existing schema 16;
- byte-accurate handling of unknown usage;
- transactionally sequenced event append;
- idempotent create-or-get run;
- workspace lease acquisition, renewal, release, and fencing;
- agent, workspace, session, message, attempt, approval, route, usage, container, and provider-connection records;
- migration runner with checksums;
- database copy and backup tools.

Exit gate:

- Python reads a TypeScript-created database and returns equivalent records;
- TypeScript reads a Python-written schema-16 database during the compatibility interval;
- state-machine and lease tests pass under concurrent processes;
- crash injection at every transaction boundary preserves invariants.

Rollback:

- no irreversible schema change before the copied-database tests pass.

### Phase 5: Engine protocol and fake worker

Deliverables:

- protocol schema and version handshake;
- Python worker SDK;
- Manager supervisor;
- frame and stderr limits;
- request timeout and heartbeat;
- cancellation and verified process-tree reaping;
- environment allowlist;
- worker-to-Manager tool callback;
- raw engine-event journal;
- protocol fuzz tests.

Exit gate:

- a malicious fixture worker cannot emit an oversized frame, invalid JSON, forbidden method, or unbounded stderr without being stopped and recorded;
- cancellation leaves no worker child process;
- worker crash becomes a typed run failure or retry according to policy;
- stale worker output cannot mutate a newer attempt.

Rollback:

- fake engine can run in-process for diagnosis, but production continues using TypeScript.

### Phase 6: Pinned Hermes worker

Deliverables:

- exact Hermes dependency and lock;
- engine-version verification at startup;
- Hermes worker bootstrap with quiet output and stdout protocol isolation;
- callback bridge for text, reasoning, status, tool, usage, warning, and terminal events;
- Lite-owned transcript input and output classifier;
- tool execution returned to Manager;
- cancellation bridge;
- provider configuration through operation-scoped input;
- Hermes persistence, gateway, delivery, and unrestricted tool registry disabled by default.

Exit gate:

- deterministic mocked-provider scenarios produce canonical Lite traces;
- one real local Hermes-backed text run passes;
- one real tool run executes through Lite runtime and publishes an owned artifact;
- a Hermes worker cannot access Manager DB, Docker socket, snapshot root key, or public app token;
- two concurrent runs use isolated worker state.

Rollback:

- select the fake or TypeScript engine through configuration.

### Phase 7: Differential shadow execution

Deliverables:

- shadow mode that runs TypeScript and Python/Hermes against deterministic inputs;
- semantic trace comparator;
- field-level divergence reports;
- redacted fixture capture;
- acceptance thresholds by event type and terminal outcome;
- a corpus covering normal, failure, and recovery paths.

Shadow mode must never duplicate external side effects. Tool calls use a record/replay runtime or execute only in an isolated disposable workspace with delivery disabled.

Exit gate:

- all preserved deterministic scenarios reach equivalent terminal outcomes;
- event ordering, tool arguments, budgets, usage nullability, approval behavior, and artifacts meet defined equivalence rules;
- every divergence is fixed or documented as an intentional contract change.

Rollback:

- disable shadow mode without state migration.

### Phase 8: Python RunService and scheduler cutover

Deliverables:

- Python run coordinator;
- state transitions;
- per-workspace and per-session queues;
- total, model-idle, and command timeouts;
- approval waiters with restart-safe records;
- steering queue;
- subagent parent-child graph and budget propagation;
- graceful shutdown and reconciliation;
- cleanup debt.

Exit gate:

- all control-plane characterization tests pass;
- kill and restart during every nonterminal state produces the expected terminal or resumed result;
- duplicate run submissions do not start duplicate work;
- subagents cannot exceed parent tool or model authority;
- shutdown either reaps or records every active resource.

Rollback:

- route new runs back to TypeScript while preserving shared schema compatibility.

### Phase 9: Python Gateway and SDK cutover

Deliverables:

- public routes matching API v1;
- app and run tokens;
- owner-scoped authorization;
- request and response limits;
- replayable SSE with cursor and Last-Event-ID semantics;
- OpenAPI generation;
- Python and TypeScript SDK generation;
- compatibility tests against both Gateway implementations;
- hardened webhook ingress.

Exit gate:

- existing SDK test suites pass unchanged;
- a disconnected client resumes without missing or duplicating events;
- unauthorized lookup returns the documented non-enumerating response;
- auth rate limiting and token revocation survive restart;
- OpenAPI compatibility diff is approved.

Rollback:

- switch listener ownership back to the TypeScript Gateway.

### Phase 10: Runtime, workspace, artifacts, and snapshots

Deliverables:

- Python Docker runtime adapter;
- immutable runtime profiles;
- managed volume and registered-bind modes;
- leases and fencing enforced at every write boundary;
- container and volume reconciliation;
- encrypted snapshot create, restore, previous-good recovery, and cold-workspace lifecycle;
- artifact promotion and quarantine;
- disk quotas and emergency checks;
- cross-platform process and Docker behavior.

Exit gate:

- existing workspace and snapshot evidence is reproduced;
- Docker restart and process crash preserve the workspace;
- a stale fencing token cannot write or publish;
- denied mounts, network, Docker socket, and host paths remain inaccessible;
- corrupt newest snapshot restores from previous-good generation.

Rollback:

- Python Manager can invoke the legacy runtime adapter through a temporary process bridge until native parity is complete.

### Phase 11: Provider, credential, and routing convergence

Deliverables:

- Lite credential broker interface for OS store, environment development mode, and Hermes-supported secret sources;
- route-plan snapshot before inference;
- capability filtering;
- provider health and explicit fallback;
- usage and price provenance;
- delegated-runtime adapters;
- protected live-provider CI lanes;
- no secret values in logs, evidence, or worker journals.

Exit gate:

- deterministic provider conformance passes;
- protected live OpenAI, Anthropic, and delegated Codex lanes pass with zero skips;
- expired credentials refresh once;
- fallback never repeats a visible side effect;
- unknown price or usage remains unknown;
- worker secret access is operation-scoped and audited.

Rollback:

- disable a Hermes provider adapter independently and retain other routes.

### Phase 12: Optional capability migration

Migrate one capability family at a time:

1. skills;
2. plugins;
3. MCP;
4. browser;
5. integrations and durable delivery;
6. automation;
7. subagents;
8. memory;
9. context optimization.

Each family requires:

- manifest and permission model;
- immutable per-run snapshot;
- disabled-state scale-to-zero proof;
- crash and upgrade behavior;
- owner isolation;
- uninstall behavior;
- conformance fixtures;
- threat-model update.

Exit gate:

- an optional family cannot widen base policy;
- disabled modules import no entry code and start no process;
- compatibility adapters are isolated and clearly labeled;
- delivery obligations survive process restart without duplicate external sends.

Rollback:

- each family has an independent feature flag and data migration boundary.

### Phase 13: Product experience and operator control center

Deliverables:

- CLI and TUI for setup, doctor, provider connection, run creation, live events, approvals, artifacts, recovery, and engine diagnostics;
- web control center only after API and event semantics stabilize;
- accessible approval and recovery flows;
- explainable policy decisions;
- run timeline with engine provenance, budget, usage, tools, artifacts, subagents, and delivery state;
- provider and secret-source setup that never reveals secret values after entry;
- plugin permission review before activation.

Exit gate:

- a new user can install, configure, create an agent, run a tool task, approve or deny, download an artifact, restart services, replay the run, restore a workspace, and diagnose a failure without editing source files;
- keyboard-only and screen-reader paths cover setup, approvals, and recovery;
- destructive actions communicate scope, permanence, and rollback.

Rollback:

- CLI remains the primary supported surface; the web control center is optional.

### Phase 14: Performance program

Current deterministic Windows baseline at the pinned Lite commit:

- startup to readiness: 1845.2 ms;
- fake in-memory run to terminal: 82.9 ms;
- Gateway RSS: 114,692,096 bytes;
- Manager RSS: 122,073,088 bytes.

These are comparison points, not universal targets. The Python rebuild must add trustworthy cold and warm measurements for:

- process startup;
- Manager readiness;
- engine-worker cold start;
- engine-worker warm dispatch;
- run acceptance latency;
- first public event;
- first model token excluding and including provider time;
- event append and replay throughput;
- SQLite p50, p95, and p99 write latency;
- cancellation-to-reap time;
- tool dispatch overhead;
- memory at idle and under 1, 10, and bounded maximum concurrent runs;
- snapshot throughput;
- browser and integration delivery latency.

Initial performance budgets should be proposed only after the Python fake slice and Hermes worker are measured on the same hardware. Candidate optimizations, in order:

1. remove eager imports from cold paths;
2. cache immutable configuration and schemas;
3. prewarm a bounded worker slot;
4. batch event persistence without weakening cursor durability;
5. reuse prepared statements;
6. avoid copying large message and tool payloads;
7. coalesce UI rendering, not durable event writes;
8. move blocking provider and filesystem work off the event loop;
9. enable uvloop on supported Unix systems if tests prove benefit;
10. evaluate faster serializers under strict compatibility tests;
11. move only measured CPU hot spots to native code.

Exit gate:

- no critical user journey is slower than its approved regression budget;
- improvements are measured with confidence intervals or repeated-run distributions;
- benchmark artifacts identify commit, OS, architecture, Python, engine version, provider lane, and runtime;
- no benchmark substitutes a fake provider result for a real-model claim.

Rollback:

- every performance optimization is isolated and can be disabled independently.

### Phase 15: Security and cross-platform qualification

Deliverables:

- updated threat model and data-flow diagrams;
- process, container, credential, browser, plugin, integration, and update attack reviews;
- dependency and provenance policy;
- fuzzing for protocol, schemas, archives, and URL policy;
- Linux, macOS, and Windows qualification;
- x64 and arm64 runtime-image qualification where supported;
- rootless Docker lane;
- sleep/resume and Docker Desktop restart lanes;
- hostile fixture workers and plugins;
- secret-redaction corpus;
- recovery drills.

Exit gate:

- every protected asset and trust boundary has an enforcing control and test;
- no critical or high validated finding remains open;
- platform matrix and protected provider lanes pass for the exact release candidate;
- SBOM and provenance are generated from release artifacts;
- regular Docker limitations remain documented honestly.

Rollback:

- release remains at the last qualified implementation.

### Phase 16: Final cutover and TypeScript removal

Deliverables:

- Python becomes the default and only production implementation;
- migration utility imports existing config, database, workspaces, provider profiles, skills, plugins, and selected evidence metadata;
- TypeScript SDK remains generated and supported;
- TypeScript application packages move to archive history and are removed from build and release;
- compatibility worker is the only place legacy plugin code can run;
- documentation, installers, examples, images, and support matrix are updated;
- rollback package for the final migration window.

Exit gate:

- production Python contains no import, subprocess call, or runtime dependency on legacy TypeScript application code;
- every preserved current-alpha gate and every new Python/Hermes gate has current evidence;
- upgrade from the pinned TypeScript alpha works on copied real data;
- rollback before the irreversible boundary is documented and tested;
- fresh install, upgrade, backup, restore, uninstall, and reinstall journeys pass;
- release artifacts meet startup, idle-memory, disk, dependency, and security budgets.

Only after this gate should legacy production code be deleted.

## 12. Test architecture

### 12.1 Characterization tests

Capture what the current implementation does before translating it. These tests answer: did the new system preserve observable behavior?

### 12.2 Contract tests

Validate schemas, error envelopes, OpenAPI, SDK route coverage, IPC messages, engine protocol, plugin ABI, and capability broker boundaries.

### 12.3 Differential tests

Run the same deterministic scenario through TypeScript and Python/Hermes. Compare semantic traces, not timestamps or generated IDs.

### 12.4 Property and state-machine tests

Use generated sequences to prove:

- only legal run transitions occur;
- event sequences never regress or duplicate;
- idempotency is stable;
- budgets never increase after delegation;
- policy grants only narrow;
- stale fencing tokens never write;
- terminal runs never become nonterminal;
- delivery obligations do not deliver more than allowed;
- migration replay is deterministic.

### 12.5 Failure and chaos tests

Inject failure at:

- every SQLite transaction boundary;
- worker start, handshake, stream, tool request, and terminal event;
- Gateway disconnect;
- Manager kill;
- Docker daemon restart;
- provider disconnect and truncated stream;
- credential refresh;
- snapshot write and restore;
- disk full;
- browser redirect and DNS rebinding;
- connector duplicate delivery;
- plugin crash and restart;
- system sleep and resume.

### 12.6 Security tests

Include:

- resource enumeration attempts;
- token scope confusion;
- path traversal;
- archive traversal and symlink attacks;
- hostile JSON depth and size;
- protocol frame flooding;
- stderr secret exfiltration;
- environment inheritance mistakes;
- command approval bypass;
- prompt request to widen tools;
- stale worker replay;
- private-network browser access;
- credential-bearing URLs;
- cross-owner artifact, memory, browser, and session access;
- malicious plugin manifests;
- supply-chain lock drift.

### 12.7 Upgrade tests

Keep fixture databases and workspaces from every supported released schema. Upgrade tests must use copies and verify record counts, hashes, event cursors, snapshots, artifacts, and new-run behavior.

## 13. Product design workstream

The product should feel like a transparent control room, not a black box with a blinking cursor.

### 13.1 Core journeys

1. **Install and diagnose**: detect Python, Docker, runtime image, secret store, ports, and engine version.
2. **Connect a model provider**: select provider, choose secret source, verify connection, inspect supported capabilities.
3. **Create an agent**: instructions, model needs, tools, skills, budget, workspace policy.
4. **Run and watch**: live text, reasoning status, tool calls, approvals, usage, subagents, artifacts, and delivery.
5. **Approve safely**: show exact command or action, arguments, workspace, network destination, policy reason, scope, and consequences.
6. **Recover**: explain interrupted runs, cleanup debt, snapshot generations, previous-good restore, and replay cursor.
7. **Inspect trust**: show engine version, route, credential provenance category, runtime image digest, policy digest, skill/plugin digests, and network policy.
8. **Manage optional capabilities**: install, review permissions, enable, disable, upgrade, and uninstall.

### 13.2 Information architecture

Primary navigation:

- Home and readiness;
- Agents;
- Runs;
- Workspaces;
- Providers;
- Capabilities;
- Automations;
- Integrations;
- Security and approvals;
- Operations and recovery;
- Settings and updates.

### 13.3 Run inspector

The run inspector is the central product surface:

- top summary: status, duration, budget, usage, workspace, engine, provider;
- ordered timeline from durable events;
- expandable reasoning-status lane without exposing private hidden reasoning by default;
- tool cards with requested arguments, approval, runtime, result, and artifact links;
- subagent tree;
- workspace and snapshot state;
- delivery obligation state;
- raw diagnostic export with redaction preview;
- cancel, steer, retry-safe, and recover actions that reflect actual state.

### 13.4 Approval design

An approval must answer:

- what will happen;
- why the agent requested it;
- what resource it can affect;
- what data can leave the machine;
- whether the action is reversible;
- how long the approval lasts;
- whether it applies once, for the session, or as a durable rule;
- which deny rule or policy triggered.

Hermes smart approval may be displayed as an advisory risk assessment. It cannot silently override Lite-Harness policy or human-required gates.

### 13.5 Recovery design

Recovery surfaces should distinguish:

- run interrupted but workspace safe;
- worker gone and run reconciled;
- cleanup pending;
- latest snapshot corrupt but previous-good available;
- provider unavailable;
- integration delivery pending;
- external qualification not configured.

Avoid generic red banners. Each state needs a bounded next action and evidence link.

### 13.6 Visual direction

Design principles:

- dense but calm information hierarchy;
- visible trust boundaries;
- progressive disclosure for advanced details;
- keyboard-first operation;
- accessible contrast and focus;
- durable state and live state visually distinct;
- warnings use severity and consequence, not theatrical color;
- no decorative animation on critical approval or recovery paths;
- long event streams virtualized and incrementally rendered.

A full visual exploration should produce three directions in Product Design Work mode before implementation. The selected direction then receives a responsive prototype, accessibility pass, and design-to-code QA.

## 14. Upstream Hermes maintenance policy

Hermes is a fast-moving upstream. Treat it like a browser engine dependency, not copied application code.

For each proposed Hermes update:

1. fetch the signed tag and exact commit;
2. verify license and provenance;
3. regenerate the dependency lock and SBOM;
4. review release notes for agent-loop, provider, tool, persistence, secret, gateway, and security changes;
5. run engine-protocol contract tests;
6. run deterministic Hermes conformance;
7. run differential traces against the previously supported Hermes version;
8. run local model and Docker qualification;
9. run protected provider lanes;
10. inspect performance distributions;
11. update compatibility matrix and migration notes;
12. canary behind an engine installation flag;
13. preserve the previous engine until rollback expires.

Do not patch upstream files in place. Required changes should be:

- contributed upstream;
- implemented in the adapter;
- maintained as a minimal, documented patch series with tests and automatic rebase conflict detection.

## 15. Git and branch strategy

Do not rewrite `lite-main` history.

Recommended refs:

```text
lite-main                              current protected line
baseline/typescript-alpha-2026-07-18  immutable baseline ref
plan/python-hermes-rebuild-v2026-7-20 this blueprint
rebuild/python-control-plane          implementation integration branch
```

Recommended feature flags during migration:

```text
LITE_HARNESS_GATEWAY_IMPL=typescript|python
LITE_HARNESS_MANAGER_IMPL=typescript|python
LITE_HARNESS_ENGINE=fake|legacy|hermes
LITE_HARNESS_STORAGE_WRITER=typescript|python
LITE_HARNESS_SHADOW_ENGINE=off|hermes
```

Flags must be validated combinations, not arbitrary mixtures. Unsupported combinations fail at startup.

No force update is allowed on shared branches. Urgent fixes land on `lite-main`, then are forward-ported with explicit provenance. Migration commits remain reviewable and small enough to revert.

## 16. Proposed pull request and commit sequence

### PR 01: Migration charter

- add baseline manifest;
- add ADR for Python control plane and Hermes worker boundary;
- add ownership matrix;
- add migration labels and CODEOWNERS.

### PR 02: Characterization corpus

- golden run traces;
- failure traces;
- contract inventory;
- current benchmark capture.

### PR 03: Schema source of truth

- JSON Schemas;
- TypeScript compatibility generation;
- Python model generation;
- OpenAPI diff gate.

### PR 04: Python workspace

- `pyproject.toml`;
- `uv.lock`;
- lint, typing, tests, packaging;
- cross-platform CI.

### PR 05: Python fake vertical slice

- Python Gateway and Manager;
- fake engine;
- run, event, replay, shutdown.

### PR 06: SQLite schema-16 compatibility

- Python repositories;
- event sequence and idempotency;
- copied-database tests.

### PR 07: Engine protocol

- schemas;
- supervisor;
- fake worker;
- cancellation and hostile-worker tests.

### PR 08: Hermes worker bootstrap

- pinned dependency;
- handshake;
- version verification;
- quiet protocol-safe bootstrap.

### PR 09: Hermes event and tool bridge

- event mapper;
- Manager-owned tool execution;
- usage and terminal mapping;
- local model qualification.

### PR 10: Differential runner

- record/replay runtime;
- semantic trace comparator;
- divergence reports.

### PR 11: Python control plane parity

- state machine;
- queues;
- approvals;
- steering;
- timeouts;
- subagents;
- reconciliation.

### PR 12: Python Gateway parity

- auth;
- public routes;
- SSE;
- OpenAPI;
- SDK compatibility.

### PR 13: Runtime and workspace parity

- Docker;
- workspaces;
- artifacts;
- snapshots;
- recovery.

### PR 14: Provider and credential convergence

- route plans;
- secret broker;
- usage and prices;
- protected provider lanes.

### PR 15: Capability families

Use separate PRs for skills, plugins, MCP, browser, integrations, automation, memory, subagents, and context optimization. Do not create a single optional-systems mega-PR.

### PR 16: Product surfaces

- CLI and TUI;
- doctor;
- run inspector;
- approvals and recovery;
- optional web control center.

### PR 17: Performance and security qualification

- benchmark budgets;
- profiles and optimizations;
- threat model;
- fuzz and chaos lanes;
- platform matrix.

### PR 18: Default cutover

- Python defaults;
- upgrade tool;
- rollback package;
- release candidate.

### PR 19: Legacy deletion

- remove TypeScript production application;
- retain generated TypeScript SDK;
- archive compatibility fixtures;
- prove zero legacy runtime dependency.

Each PR should contain one coherent architectural move. A commit should not combine schema, behavior, broad formatting, generated artifacts, and unrelated cleanup.

## 17. Risk register

| Risk | Failure mode | Mitigation | Release gate |
| --- | --- | --- | --- |
| Double control plane | Lite and Hermes disagree on run or session state | Lite is sole authority; worker persistence disabled | copied-state and crash tests |
| Event drift | clients miss, duplicate, or misorder events | Manager assigns sequence transactionally | replay and differential tests |
| Tool bypass | Hermes executes tools outside Lite policy | worker tool registry restricted; all execution brokered | hostile worker and policy tests |
| Secret leak | credential enters env, log, journal, prompt, or container | operation-scoped broker, env allowlist, redaction tests | secret corpus and process inspection |
| Cancellation leak | worker or child remains running | structured cancellation, process-tree verification, cleanup debt | cancellation-to-reap test |
| Workspace split brain | stale worker writes after lease loss | fencing token checked on every write and artifact publish | stale-token chaos test |
| Schema corruption | Python migration damages real SQLite data | copied databases, backup, transactional migrations | upgrade matrix |
| Upstream churn | Hermes API changes break adapter | exact pin, protocol adapter, differential upgrade lane | engine compatibility matrix |
| Python performance | cold imports, GIL, or serialization regress latency | process isolation, prewarm, profile first, native hotspots only | benchmark budgets |
| Windows divergence | process, pipe, signal, path, or Docker behavior differs | dedicated Windows tests and process primitives | platform qualification |
| Supply chain | dependency drift or malicious release | exact lock, provenance, SBOM, reviewed update | release provenance gate |
| UI hides risk | approval or recovery action is misunderstood | consequence-first UX and accessibility testing | journey tests |
| Repository bloat | large history and generated assets slow development | artifact audit, LFS or release assets where appropriate, no source vendoring of Hermes | repository health gate |
| Scope explosion | every Hermes feature is activated before core parity | staged adoption and ownership matrix | phase exit enforcement |

## 18. Definition of done

The project is fully rebuilt and ready for a beta claim only when all of the following are true:

### Architecture

- Python Gateway and Manager are the only production control-plane implementations.
- Hermes runs behind a pinned, versioned, isolated engine protocol.
- No production path imports or launches legacy TypeScript application code.
- Gateway remains unable to control Docker directly.
- Optional capabilities remain removable and scale to zero.

### Compatibility

- public API v1 compatibility is proven;
- Python and TypeScript SDKs pass;
- existing databases and workspaces upgrade safely;
- event replay, idempotency, cancellation, steering, approvals, artifacts, snapshots, providers, plugins, browser, integrations, automation, subagents, and memory meet preserved behavior decisions.

### Security

- all listed invariants have current tests;
- no open critical or high validated finding;
- credentials remain outside run state and untrusted runtimes;
- cross-owner access tests pass;
- browser and network boundaries pass;
- SBOM, provenance, licenses, and redaction evidence are current.

### Reliability

- process, Manager, Gateway, worker, Docker, and host restart scenarios pass;
- workspace and snapshot recovery pass;
- delivery obligations survive restart;
- cleanup debt reconciles;
- no skipped required test is reported as success.

### Performance

- approved cold, warm, memory, throughput, and cancellation budgets pass on supported platforms;
- model-backed claims use real model lanes;
- no optimization weakens durability or policy.

### Product

- install, setup, provider connection, agent creation, live run, approval, artifact download, restart, replay, restore, doctor, upgrade, and rollback journeys are documented and tested;
- critical flows are keyboard accessible and screen-reader usable;
- engine and security provenance is inspectable.

### Release

- Linux, macOS, and Windows candidate lanes pass;
- protected provider lanes pass;
- release artifacts are reproducible and signed according to project policy;
- migration and rollback instructions are proven on copied real data;
- support tiers and known limitations are accurate.

## 19. First implementation slice

The first code slice should not port the whole repository. It should prove the architecture with one secure vertical path:

1. generate Python contracts from the frozen v1 schemas;
2. start Python Gateway and Manager as separate processes;
3. create or open a schema-16 SQLite database;
4. accept one idempotent run;
5. acquire a fenced workspace lease;
6. spawn a pinned Hermes worker through bounded JSON-line RPC;
7. stream model text into canonical Lite events;
8. accept one Hermes tool request;
9. execute the tool through Lite runtime and policy;
10. publish one owned artifact;
11. record usage without converting unknown values to zero;
12. checkpoint the workspace;
13. terminate and verify worker cleanup;
14. disconnect and replay the complete event stream;
15. restart Manager and verify the terminal state and artifact.

That slice exercises the real fault lines: contracts, persistence, engine boundary, tool authority, event durability, workspace fencing, artifacts, usage, cancellation, cleanup, and replay. Once it passes, the rest of the migration is expansion rather than speculation.

## 20. Decision summary

Adopt Python as the new control-plane language, pin Hermes Agent v0.19.0 as an isolated execution engine, preserve Lite-Harness as the durable security and lifecycle authority, and use measured native acceleration only for proven hot spots.

Do not erase working architecture to make the repository look newly rewritten. Build a second implementation beside it, compare behavior, cut over one authority at a time, and delete legacy code only after the evidence says it is dead.
