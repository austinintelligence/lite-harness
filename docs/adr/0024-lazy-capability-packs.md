# ADR 0024: Large features are lazy capability packs

- Status: accepted
- Date: 2026-07-14
- Requirement: D24
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 210-210
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> Large features are capability packs that are lazy-started and removable.

## Decision

Large features are capability packs that are lazy-started and removable.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: an always-loaded ecosystem bundle. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Concrete ecosystem code and unreviewed plugins stay outside the trusted kernel and are activated only through explicit capability and process boundaries.

## Compatibility impact

Capability-pack and plugin contracts are versioned; disabled packs have zero process, import, timer, socket, container, and network activity.

## Migration plan

Move concrete imports to composition roots, publish a narrow plugin SDK, supervise third-party workers, and retain in-process execution only for reviewed built-ins.
