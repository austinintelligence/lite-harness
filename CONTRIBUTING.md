# Contributing

Lite-Harness is being transformed from a pinned OpenClaw baseline into a small
kernel with optional capability packs. Changes must preserve the dependency
direction and security invariants in `LITE_HARNESS_ARCHITECTURE_PLAN.md`.

## Development workflow

1. Use Node 24 and the pinned pnpm version.
2. Run `pnpm install --frozen-lockfile`.
3. Make a focused change with tests at the nearest contract boundary.
4. Run `pnpm verify` before opening a pull request.
5. Run `pnpm release:check` for release-bearing changes.

Do not commit credentials, `.env` files, auth stores, database files, workspace
archives, or provider responses containing secrets. Adapted upstream code must
be added to `PROVENANCE.json` and `THIRD_PARTY_NOTICES.md` in the same change.

## Architecture boundaries

- Gateway never imports Docker, storage, provider credentials, or Manager internals.
- Agent Runtime depends on ports and contracts, not concrete providers or transports.
- Optional packs must be lazy and must consume no resources while disabled.
- OpenClaw compatibility code belongs only under an explicit compatibility package.
