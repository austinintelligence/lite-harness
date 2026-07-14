# ADR 0027: Separate app, provider, and integration authentication

- Status: accepted
- Date: 2026-07-14
- Requirement: D27
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 215-216
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> App authentication, provider authentication, and integration authentication are three separate security domains.

## Decision

App authentication, provider authentication, and integration authentication are three separate security domains.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: a shared credential namespace across security domains. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Provider, app, and integration credentials cannot cross domains. Routing is policy-aware and prevents unsafe failover after side effects or partial streams.

## Compatibility impact

Provider-native features are advertised only after capability conformance. Delegated agents preserve their own protocol instead of masquerading as direct APIs.

## Migration plan

Introduce opaque credential profiles, capability discovery, persisted route decisions, canonical requests, side-effect-aware fallback, and supervised delegated adapters.
