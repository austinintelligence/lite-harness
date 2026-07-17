# Raw pinned OpenClaw comparison

This comparison uses the exact OpenClaw ancestor recorded in `PROVENANCE.json`:

- commit: `834810b3d6e367cbdf69b4c822d220f1a150b14c`
- version: `2026.7.2`
- license: MIT
- commit date: 2026-07-13

The source was checked out into a temporary detached worktree, installed with
`pnpm install --frozen-lockfile --ignore-scripts`, and removed after the run.
It was not copied into the Lite production kernel and no OpenClaw credential or
runtime state was used.

## Raw checkout observations

The pinned checkout contains 168 workspace projects, 10,263 files below
`src/`, and 7,546 files below `extensions/`. It has no checked-in `dist/`
directory and therefore requires its own build before its CLI can be started.
The install completed successfully on this machine with Node `24.14.0` and
pnpm `11.2.2`, but emitted the upstream engine warning: this OpenClaw commit
requires Node `24.15.0+` (or the corresponding supported Node 22/25 ranges).

The raw `pnpm test:unit:fast` run was not a clean qualification: it reported
many failures in SQLite-backed device-pairing, session, trajectory, and state
tests, then stalled without output and was terminated by OpenClaw's 120-second
watchdog. The first diagnostics identify the host Node/SQLite safety floor as a
cause. A focused allowlist run completed 24 tests, skipped 1, and failed 1
(`exec-allowlist-matching.test.ts`). This is a reproducible environment-bound
baseline result, not a claim that all upstream behavior is broken.

## What is comparable

Lite-Harness compares selected user-visible behavior through executable
fixtures and explicit adapters. The relevant current local evidence is:

| Surface | Lite observation |
| --- | --- |
| Deterministic host suite | 67 files, 350 tests passed before the current evidence-only runner additions |
| Real Docker/browser runtime | 174/174 checks, zero skips |
| Public SDK to model to Docker vertical | Passed with a pinned tool image, artifact bytes, restart replay, usage, and provider-secret absence |
| OpenRouter one-agent corpus | Earlier exploratory run: 14/16; exact pushed-SHA run: 13/16, with code execution, repeated context, and browser lifecycle omissions |
| OpenRouter ten-agent concurrency | Exact pushed-SHA runs: 19/20 in two attempts (10/10 then 9/10); cross-user isolation and scoped cleanup passed |

The raw OpenClaw tree is retained as provenance and research material. File
counts or source-layout similarity are not treated as parity evidence; the Lite
kernel remains independent and the compatibility surface stays removable.
