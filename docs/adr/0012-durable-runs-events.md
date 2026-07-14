# ADR 0012: Durable runs and events

- Status: accepted
- Date: 2026-07-14
- Requirement: D12
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 193-193
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> Runs and events are durable database records, not process-memory objects.

## Decision

Runs and events are durable database records, not process-memory objects.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: process-memory run ownership as the system of record. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Durable transactional state and fencing prevent stale or concurrent writers from corrupting workspaces and lifecycle history.

## Compatibility impact

Run/event schemas and lease semantics become versioned persistence contracts. SQLite remains replaceable behind storage interfaces.

## Migration plan

Add ordered migrations, WAL/durability settings, transactional lifecycle operations, one-writer queues, lease renewal, and monotonic fencing before importing existing state.
