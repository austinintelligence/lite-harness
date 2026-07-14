# ADR 0050: Performance and zero-idle budgets

- Status: provisional
- Date: 2026-07-14
- Covers: Research 18

## Primary sources

- Kernel benchmark command: ../../scripts/benchmark-kernel.mjs (local deterministic benchmark; retrieved 2026-07-14)
- Release evidence schema: ../../schemas/release-evidence.schema.json (schema version 1; retrieved 2026-07-14)

## Decision

Initial p95 budgets on the documented reference machine are: CLI help 750 ms cold; Manager ready 2.5 s cold; warm fake-provider run 250 ms; local event projection lag 100 ms; idle Gateway+Manager RSS 150 MiB and CPU below 1%; warm-image browser ready 8 s; owned-resource cleanup 5 s; snapshot throughput 50 MiB/s with peak working memory at most 128 MiB independent of archive size. Disabled packs consume zero processes, containers, sockets, network calls, and repeating timers.

## Alternatives considered

Rejected: One fake-provider sample as a product benchmark; averages without tail latency; budgets that ignore platform and artifact hashes.

## Security impact

Resource ceilings and cleanup latency limit denial-of-service and orphan accumulation; zero-idle checks detect accidental background capability activation.

## Compatibility impact

Budgets are platform-qualified and may be amended only with evidence and an ADR, not silently relaxed when tests regress.

## Migration plan

Build repeatable cold/warm suites, record hardware/runtime/artifact hashes and sample distributions, run supported platforms, then replace provisional numbers with measured accepted thresholds.

## Release impact

Provisional until statistically meaningful multi-platform evidence exists; regressions beyond accepted budgets block release.
