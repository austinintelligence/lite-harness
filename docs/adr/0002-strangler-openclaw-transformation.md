# ADR 0002: Strangler transformation of OpenClaw

- Status: accepted
- Date: 2026-07-14

## Decision

Migrate one observable behavior at a time:

```text
characterize -> define contract -> wrap -> rewrite -> compare -> cut over -> delete
```

Only `compat/openclaw` may eventually import both Lite and legacy types. New
features cannot land in legacy code, and production imports into legacy code
must monotonically decrease to zero before 1.0.

## Consequences

- File similarity to OpenClaw is not a goal.
- Behavior and failure conformance tests determine what is preserved.
- Upstream changes are reviewed and selectively reimplemented; branches are
  not continuously merged.
