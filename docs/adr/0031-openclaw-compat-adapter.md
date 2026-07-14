# ADR 0031: OpenClaw compatibility is an adapter

- Status: accepted
- Date: 2026-07-14
- Requirement: D31
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 224-225
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> OpenClaw compatibility is an adapter and migration path, not the permanent internal architecture.

## Decision

OpenClaw compatibility is an adapter and migration path, not the permanent internal architecture.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: retaining OpenClaw internals as the permanent kernel. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Legacy behavior is isolated behind adapters and characterized fixtures, preventing inherited privilege assumptions from becoming permanent kernel contracts.

## Compatibility impact

Only behavior proven by the compatibility suite is preserved. File layout, private symbols, and incidental implementation details are explicitly non-contractual.

## Migration plan

Characterize behavior, define a Lite-owned contract, wrap and compare, cut over one surface at a time, then delete legacy production imports while retaining provenance.
