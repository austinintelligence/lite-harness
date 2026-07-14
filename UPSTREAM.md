# Upstream provenance

Lite-Harness is a cleanly bounded transformation of useful OpenClaw behavior,
not a continuously merged product fork.

## Frozen baseline

- Repository: `openclaw/openclaw`
- Repository ID: `1103012935`
- Commit: `834810b3d6e367cbdf69b4c822d220f1a150b14c`
- Package version at that commit: `2026.7.2`
- License declared by the package: MIT
- Baseline tag to create when this repository has history: `openclaw-baseline`

The current Lite-Harness kernel contains no copied OpenClaw source. When code is
adapted later, add the source path, upstream commit, local destination, license,
behavior tests, and material changes to `PROVENANCE.json` before merging it.

## Intake policy

- Security fix: review and port against Lite contracts.
- Provider protocol change: implement in its provider pack.
- Useful feature: characterize behavior and rebuild behind a Lite contract.
- OpenClaw-only refactor: ignore.
- Compatibility regression: contain it in `compat/openclaw`.

Never merge OpenClaw `main` wholesale after extraction begins.
