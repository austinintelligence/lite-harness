# ADR 0047: OpenClaw preservation boundary

- Status: accepted
- Date: 2026-07-14
- Covers: Research 15

## Primary sources

- Pinned OpenClaw source: https://github.com/openclaw/openclaw/commit/834810b3d6e367cbdf69b4c822d220f1a150b14c (baseline commit 834810b3; retrieved 2026-07-14)
- Lite provenance: ../../PROVENANCE.json (schema version 1; retrieved 2026-07-14)
- Compatibility contract: ./0031-openclaw-compat-adapter.md (ADR 0031; retrieved 2026-07-14)
- Behavior contract: ./0032-behavior-defined-compatibility.md (ADR 0032; retrieved 2026-07-14)

## Decision

Preserve only behavior selected by an explicit inventory and executable fixtures from the pinned OpenClaw baseline. Skills precedence, plugin/browser/provider/integration behavior, config import, and migration semantics are characterized independently. Upstream source remains provenance and research material; it is not continuously merged and cannot re-enter the Lite kernel.

## Alternatives considered

Rejected: Tracking OpenClaw main by merge; preserving every user-visible behavior; using copied file layout as evidence.

## Security impact

Prevents inherited broad privilege and credential assumptions from bypassing Lite-owned contracts.

## Compatibility impact

Every preserved, adapted, preview, deferred, and removed behavior gets a reason and fixture. Uninventoried behavior is not promised.

## Migration plan

Complete the behavior inventory, capture fixtures at the pinned commit, implement through adapters, compare, and delete legacy production imports surface by surface.

## Release impact

Blocks compatibility claims until the inventory and required fixtures are complete.
