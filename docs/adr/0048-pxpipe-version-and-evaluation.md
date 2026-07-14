# ADR 0048: pxpipe version, license, and evaluation policy

- Status: accepted
- Date: 2026-07-14
- Covers: Research 16

## Primary sources

- pxpipe installation: https://pxpipe.dev/installation (current documentation; retrieved 2026-07-14)
- pxpipe repository: https://github.com/teamchong/pxpipe (upstream source; retrieved 2026-07-14)
- npm registry metadata: https://registry.npmjs.org/pxpipe-proxy/0.8.0 (pxpipe-proxy 0.8.0, MIT; retrieved 2026-07-14)

## Decision

The plan's 0.7.1 versus 0.8.0 conflict is resolved in favor of the plan-pinned pxpipe-proxy 0.8.0 release under MIT; the same-day 0.9.0 release does not satisfy the repository's dependency minimum-age policy. pxpipe remains optional, disabled by default, and runs only after final route selection while exact text stays canonical. Promotion requires measured end-to-end task quality plus full provider-billed input/image/output/cache tokens, cost, latency, recovery, failure, and memory - not PNG byte size alone.

## Alternatives considered

Rejected: Freezing either stale plan version; enabling from image-size reduction; applying it before model selection.

## Security impact

Exact canonical recovery and kill switches prevent irreversible context loss; optional loading keeps its attack/resource surface absent when disabled.

## Compatibility impact

0.8.0 is pinned only for evaluation until its API and model behavior pass fixtures. The plugin contract isolates future upgrades.

## Migration plan

Upgrade the optional dependency to 0.8.0, update API fixtures, run deterministic recovery tests and Hermes-routed model evals, then keep disabled unless thresholds are met.

## Release impact

pxpipe is preview and cannot satisfy an alpha gate; its stale 0.7.1 dependency must be corrected.
