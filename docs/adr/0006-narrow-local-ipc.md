# ADR 0006: Narrow local Gateway-to-Manager IPC

- Status: accepted
- Date: 2026-07-14
- Requirement: D06
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 186-186
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> They communicate only through a narrow local socket or named-pipe protocol.

## Decision

They communicate only through a narrow local socket or named-pipe protocol.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: a remotely exposed Manager API or shared-database coordination. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Provider credentials and daemon authority stay in the privileged host plane; untrusted commands receive only brokered, policy-checked capabilities.

## Compatibility impact

Gateway and Manager may evolve independently only through versioned local IPC. Public clients cannot depend on Docker or host-path details.

## Migration plan

Move privileged operations behind typed Manager commands, reject raw authority at Gateway schemas, and remove any direct Gateway imports of runtime/provider implementations.
