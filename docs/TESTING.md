# Testing and model-backed evaluation

Credential-free unit, contract, and failure tests continue to use deterministic
fakes. They do not choose or contact a model. Process-adapter tests use local
JSONL fixtures and are also intentionally model-free.

All model-backed harness tests and evaluations on the maintainer workstation
run through the gitignored `.env.hermes.local` policy using:

- `LITE_HARNESS_PROVIDER=openai-compatible`
- `LITE_HARNESS_PROVIDER_BASE_URL=http://127.0.0.1:8645/v1`
- `LITE_HARNESS_MODEL=gpt-5.6-luna`

The Hermes wrapper sets both model price rates to zero for these localhost-only
OAuth-backed test runs because they have no per-token API charge. This exception
is scoped to the local test wrapper; normal direct-provider runs must configure
their current non-negative input and output rates explicitly.
- a non-empty local placeholder in `LITE_HARNESS_PROVIDER_API_KEY`

Hermes owns upstream OAuth. Lite-Harness must not discover, export, modify, or
persist the upstream OpenAI credential. Run the live conformance smoke with
`pnpm test:hermes`. Wrap any future model-backed Node test or evaluation with
`node scripts/with-hermes-model.mjs node <script> [...args]` so the local policy
overrides ambient direct-provider variables for that invocation only.

`pnpm evaluate:pxpipe` remains model-free and measures local rendering,
latency, bytes, and exact recovery. `pnpm evaluate:pxpipe:hermes` is the only
model-backed pxpipe evaluation: it uses the same wrapper and records a paired
text-versus-optical quality and full-bill report without persisting upstream
credentials.

## CI and release automation

The branch workflow is safe to run for every pull request and `lite-main` push:

- `pnpm verify` runs on Linux, macOS, and Windows.
- Python SDK unit tests run on all three operating systems.
- The Ubuntu `packaged-python-parity` job clean-installs the compiled
  application, TypeScript SDK, contracts, and Python wheel; it exercises both
  SDKs through separate Manager/Gateway processes, rejects a second Manager,
  and uploads `m1-packaged-artifacts` zero-skip evidence.
- The Linux readiness job runs the production dependency audit, regenerates the
  deterministic CycloneDX SBOM, checks secrets/provenance/release structure, and
  uploads the current readiness documents as a short-lived artifact.
- Both runtime Docker contexts are built without publishing.

The A09 workspace durability case includes a real Docker daemon restart and is
destructive to a local Docker Desktop session. It is fail-closed by default;
only an isolated evidence runner should set
`LITE_HARNESS_ALLOW_DOCKER_RESTART=1`. The required CI runtime job sets that
variable explicitly; ordinary local commands never restart Docker implicitly.

The required host matrix is produced only by the manual, pinned
`.github/workflows/external-platform-evidence.yml` workflow. Its
`pnpm evidence:external --gate <lane>` producer requires GitHub Actions,
validates the declared OS, architecture, Docker mode, and Docker Desktop
identity, then builds immutable runtime images before invoking the real suite.
The restart opt-in is scoped to that CI child process; do not run this producer
locally while preserving a Docker Desktop session.

GitHub-hosted runners cannot reach the maintainer workstation's localhost-only
Hermes proxy. Model-backed tests are therefore intentionally excluded from
hosted CI and must be run locally with `pnpm test:hermes`; their evidence belongs
in the release-evidence ledger. CI must never substitute a direct provider key.

The runtime-image workflow separates validation from publication. Manual runs
execute the strict release gate but never publish. A `v*` tag can publish only
after `pnpm release:check` succeeds, and images receive only the immutable
version tag—prereleases do not update a mutable `latest` tag. The strict gate is
expected to remain red while required ledger rows are blocked or critical/high
defects remain open; that is a release stop, not a branch-CI failure.
