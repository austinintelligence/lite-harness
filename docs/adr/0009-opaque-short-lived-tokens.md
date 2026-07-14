# ADR 0009: Short-lived opaque external tokens

- Status: accepted
- Date: 2026-07-14
- Requirement: D09
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 189-190
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> External tokens are short-lived opaque bearer tokens, not custom encrypted tokens.

## Decision

External tokens are short-lived opaque bearer tokens, not custom encrypted tokens.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: custom encrypted bearer tokens or self-contained long-lived JWTs. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Authentication is resolved once at the public boundary, then enforced as scoped internal identity. Token leakage, replay, and confused-deputy exposure are reduced.

## Compatibility impact

Clients use stable bearer-token semantics while internal principal schemas can version independently. Token formats are not a public persistence contract.

## Migration plan

Introduce short TTLs, revocation and resource binding; resolve tokens in Gateway; pass only a versioned principal envelope to Manager; invalidate legacy long-lived credentials.
