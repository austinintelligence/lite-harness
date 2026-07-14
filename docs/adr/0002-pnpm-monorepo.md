# ADR 0002: pnpm monorepo

- Status: accepted
- Date: 2026-07-14
- Requirement: D02
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 182-182
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> The project is a pnpm monorepo.

## Decision

The project is a pnpm monorepo.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: independent repositories or npm/Yarn workspaces. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Supply-chain and runtime risk are concentrated in one pinned Node/pnpm toolchain. Lockfile, engine, action, and artifact checks must remain deterministic.

## Compatibility impact

Supported packages and SDK artifacts share one versioned workspace contract. Browser consumers receive built SDK output, not Node-only internals.

## Migration plan

Keep Node 24 and pnpm 11 pinned for alpha, compile all publishable artifacts, and introduce another language or repository only behind a versioned process/API boundary.
