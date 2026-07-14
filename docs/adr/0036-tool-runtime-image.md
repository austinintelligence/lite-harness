# ADR 0036: Tool runtime image composition and patch policy

- Status: accepted
- Date: 2026-07-14
- Covers: Research 4

## Primary sources

- Dockerfile best practices: https://docs.docker.com/build/building/best-practices/ (current Docker Build; retrieved 2026-07-14)
- Playwright Docker and glibc support: https://playwright.dev/docs/docker (Playwright 1.61.1; retrieved 2026-07-14)
- Node official images: https://github.com/nodejs/docker-node (Node 24 bookworm-slim; retrieved 2026-07-14)

## Decision

Replace the Alpine/BusyBox tool image with a digest-pinned Debian bookworm-slim/glibc image containing Node 24, CA certificates, tini, bash, git, and a package-manager shim. Keep Python in an explicit opt-in profile. Build amd64 and arm64 from the same Dockerfile, record image digests, and refresh base digests through reviewed dependency updates.

## Alternatives considered

Rejected: The current seven-line Alpine image; floating latest tags; one maximal image containing every language toolchain.

## Security impact

Digest pinning, non-root execution, a minimal package set, init handling, and reproducible rebuilds reduce image drift and orphan processes.

## Compatibility impact

glibc supports common native Node tooling that musl images do not. Optional Python avoids imposing its patch surface on every run.

## Migration plan

Add the Debian image, health/UID/multiarch fixtures, package inventory and SBOM; migrate tool profiles; delete Alpine only after equivalent lifecycle tests pass.

## Release impact

The current Alpine image does not satisfy this ADR and blocks the verified runtime boundary.
