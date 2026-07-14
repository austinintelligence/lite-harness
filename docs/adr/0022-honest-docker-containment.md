# ADR 0022: Docker containment is not a micro-VM boundary

- Status: accepted
- Date: 2026-07-14
- Requirement: D22
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 206-207
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> Regular Docker is described honestly as containment, not micro-VM-grade tenant security.

## Decision

Regular Docker is described honestly as containment, not micro-VM-grade tenant security.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: claiming hostile multi-tenant isolation from regular Docker alone. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Optional context transforms cannot erase canonical evidence, and Docker containment is described without overstating its resistance to a hostile co-tenant or daemon compromise.

## Compatibility impact

Providers always have an exact-text fallback. pxpipe and image-context behavior remain optional, measurable capabilities rather than kernel requirements.

## Migration plan

Persist exact canonical context, apply transforms only after routing, add kill switches and recovery checks, and narrow deployment claims until stronger isolation is independently proven.
