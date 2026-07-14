# ADR 0018: Tenant-private cache ownership

- Status: accepted
- Date: 2026-07-14
- Requirement: D18
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 200-201
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> Private cache content is never shared across tenants only because its hash matches.

## Decision

Private cache content is never shared across tenants only because its hash matches.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: global cache reuse based only on matching content hashes. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Host paths, snapshots, caches, and build layers are assigned explicit owners. Encryption and tenant boundaries cannot be inferred from content hashes alone.

## Compatibility impact

Named volumes are portable across supported Docker hosts; developer bind mounts require explicit registration and narrower support claims.

## Migration plan

Inventory existing workspaces, register allowed host roots, snapshot cold state into a versioned authenticated format, and let Docker/BuildKit rebuild disposable caches.
