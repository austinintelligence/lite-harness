# ADR 0049: Supply-chain attestations and registry promotion

- Status: accepted
- Date: 2026-07-14
- Covers: Research 17

## Primary sources

- GitHub artifact attestations: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations (current GitHub Actions; retrieved 2026-07-14)
- CycloneDX specification: https://cyclonedx.org/specification/overview/ (CycloneDX 1.6; retrieved 2026-07-14)
- OCI image specification: https://github.com/opencontainers/image-spec (current OCI image spec; retrieved 2026-07-14)

## Decision

Release artifacts are built once from an immutable tag after the strict gate, hashed, accompanied by CycloneDX SBOMs, and attested by GitHub OIDC provenance to the exact commit/workflow. Container images publish by digest plus immutable version tag; prereleases never move latest. Promotion reuses verified digests rather than rebuilding. Actions and base images remain commit/digest pinned.

## Alternatives considered

Rejected: Rebuilding for each registry; mutable latest-only releases; unsigned locally produced artifacts; SBOMs without artifact linkage.

## Security impact

Attestations, immutable digests, least-privilege workflow permissions, and reproducible SBOMs make source-to-artifact substitution detectable.

## Compatibility impact

Consumers can verify a stable digest and provenance independently of registry tags. Promotion does not alter bytes.

## Migration plan

Add attestations and digest outputs to the gated release workflow, attach package/image/SBOM evidence, configure owner-approved signing/registry permissions, and verify with gh before promotion.

## Release impact

Signing authority and registry promotion remain external blockers; branch CI must never receive release write permissions.
