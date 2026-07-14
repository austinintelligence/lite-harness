# ADR 0033: Public identity and publication namespace

- Status: blocked
- Date: 2026-07-14
- Covers: Research 1

## Primary sources

- npm scopes: https://docs.npmjs.com/cli/v11/using-npm/scope (npm CLI 11; retrieved 2026-07-14)
- Python package name normalization: https://packaging.python.org/en/latest/specifications/name-normalization/ (current PyPA specification; retrieved 2026-07-14)
- GitHub Container Registry: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry (current GHCR documentation; retrieved 2026-07-14)

## Decision

Lite-Harness remains an internal codename. No npm scope, PyPI project, container namespace, domain, or public product identity is approved until the owner supplies one collision-checked name and publication scope. Private workspace package names may continue to use the codename while every package remains private.

## Alternatives considered

Rejected: Silently claiming an available-looking name; publishing first and renaming later; treating different registry normalizations as equivalent.

## Security impact

Prevents namespace squatting, dependency confusion, and accidental publication to an identity the owner does not control.

## Compatibility impact

Public package and image coordinates are intentionally not stable. Internal imports are not a promise to external consumers.

## Migration plan

Owner selects the name and scopes; verify normalized names in npm, PyPI, GitHub, GHCR, domains, and trademark search; update manifests/docs/workflows atomically; publish only from an approved signed release.

## Release impact

Blocks naming approval, signing identity, registry promotion, and every public alpha publication gate.
