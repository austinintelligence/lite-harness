# ADR 0039: SQLite driver maturity and durability policy

- Status: provisional
- Date: 2026-07-14
- Covers: Research 7

## Primary sources

- Node SQLite API: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html (Node 24.18.0, stability 1.2 release candidate; retrieved 2026-07-14)
- SQLite WAL: https://sqlite.org/wal.html (current SQLite; retrieved 2026-07-14)
- SQLite pragmas and integrity checks: https://sqlite.org/pragma.html (current SQLite; retrieved 2026-07-14)
- SQLite online backup API: https://sqlite.org/backup.html (current SQLite; retrieved 2026-07-14)

## Decision

SQLite WAL remains the first database with foreign keys enabled, bounded busy handling, FULL synchronous durability for authoritative state, explicit checkpoints, ordered transactional migrations, online backup, quick checks during operation, and full integrity plus foreign-key checks for release/recovery. Node's built-in SQLite driver is allowed only in pre-alpha while it remains release-candidate stability; verified alpha requires either stable Node status or a mature supported replacement selected by a superseding ADR.

## Alternatives considered

Rejected: Declaring a release-candidate API stable by local test success; synchronous OFF/NORMAL for authoritative lifecycle commits; file copying a live WAL database as backup.

## Security impact

Transactional ownership and integrity checks reduce contradictory state and tampered/corrupt recovery acceptance.

## Compatibility impact

Storage interfaces and migrations must not expose driver-specific statement objects. Backup format is SQLite plus manifest, not a Node API contract.

## Migration plan

Complete cross-process locking and crash tests, benchmark FULL WAL, evaluate a stable replacement, and migrate behind the storage adapter without changing public contracts.

## Release impact

Current node:sqlite stability is an explicit verified-alpha blocker.
