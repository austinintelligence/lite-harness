# ADR 0021: Exact text remains canonical context

- Status: accepted
- Date: 2026-07-14
- Requirement: D21
- Contract: `LITE_HARNESS_ARCHITECTURE_PLAN.md`, 5. Architecture decisions to freeze, lines 204-205
- Contract SHA-256: `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`

## Context

The frozen architecture contract requires:

> Canonical context always remains exact text, even if an image view is sent to a model.

## Decision

Canonical context always remains exact text, even if an image view is sent to a model.

This is a dependency and trust-boundary rule, not merely a current implementation detail. Any exception requires a superseding ADR, migration plan, and updated contract evidence.

## Alternatives considered

- Rejected: using a rendered image as the only recoverable context. It weakens the selected local-first boundary or creates a second architecture to support.
- Rejected: leaving the choice implicit. That makes compatibility, threat analysis, and release evidence non-reproducible.

## Security impact

Optional context transforms cannot erase canonical evidence, and Docker containment is described without overstating its resistance to a hostile co-tenant or daemon compromise.

## Compatibility impact

Providers always have an exact-text fallback. pxpipe and image-context behavior remain optional, measurable capabilities rather than kernel requirements.

## Migration plan

Persist exact canonical context, apply transforms only after routing, add kill switches and recovery checks, and narrow deployment claims until stronger isolation is independently proven.
