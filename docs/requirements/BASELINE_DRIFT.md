# Baseline drift record

The mission was reviewed at `f9d522289b500174e4e387b6078f907ea4ac56fa` on
`lite-main`. Work resumed on 2026-07-15 after fetching `origin/lite-main` at
`0bcdb123335e5883d66287643b22ab707d2893bb`.

## Verified invariants

- The resumed commit exactly matched `origin/lite-main` and the worktree was
  clean before this mission made any edits.
- The reviewed commit is the merge base and an ancestor of the resumed commit;
  the branch contains 110 additional commits.
- OpenClaw commit `834810b3d6e367cbdf69b4c822d220f1a150b14c` remains an
  ancestor of the resumed commit.
- `LITE_HARNESS_ARCHITECTURE_PLAN.md` remains 3,222 lines with SHA-256
  `cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f`.

## Defect reproduction disposition

The baseline reproduction programs cannot be rerun as failing reproductions on
the resumed commit. They deliberately require all 64 frozen baseline assertions
to fail; fixed assertions now pass, so `scripts/record-defect-reproductions.mjs`
correctly refuses to overwrite the frozen reproduction evidence with a partial
failure set. Replacement invariants must therefore be proved by the mapped
regression suites and fresh zero-skip evidence for the release candidate, as
required by the mission's HEAD-drift clause.

## First current-HEAD verification

The first `pnpm verify` run at the resumed commit established this baseline:

- TypeScript compilation passed.
- Dependency boundaries passed for 39 TypeScript files.
- Repository hygiene passed for 299 tracked files.
- Vitest passed 49 files and 162 tests with no skipped tests.
- Truth validation failed because 13 requirement rows used a legacy string
  evidence-reference shape instead of the versioned object shape.

That truth-layer failure is a release blocker, not a test result to suppress.
Its repair and all later candidate evidence occur after this immutable drift
record.

Machine-readable evidence is stored in
`evidence/baseline/0bcdb123335e5883d66287643b22ab707d2893bb/drift.json`.
