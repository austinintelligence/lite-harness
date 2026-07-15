# Conservative context optimization

Lite-Harness keeps a canonical exact `Context IR`. Security policy, current
state, source edits, tool schemas, and unknown-model content stay as text.
Optional pxpipe rendering is pinned to `pxpipe-proxy@0.8.0`, uses its public
`renderTextToImages` entry point, and retains immutable exact blocks in
`context.sqlite` for `context_fetch_exact` recovery. Stable block IDs,
provenance, and time ranges survive Manager restart.

The renderer verifies the installed package version before importing it. A
missing or mismatched version fails closed to the exact-text path instead of
running an unevaluated renderer while reporting stale provenance.

The gate has global, app, and model switches plus a tenant-scoped render cache.
It also requires the finally selected route to declare `vision`; images are
never compiled for a text-only or delegated route. Renderer error, a short or
protected block, an unknown model profile, or any disabled switch falls back
to text without changing run semantics. The feature is disabled by default.

Set `LITE_HARNESS_CONTEXT_FILE` to a bounded operator-owned instruction file to
compose canonical context into real runs. Optional rendering additionally
requires `LITE_HARNESS_CONTEXT_OPTIMIZATION=true` and explicit comma-separated
`LITE_HARNESS_CONTEXT_ALLOWED_APPS` and `LITE_HARNESS_CONTEXT_ALLOWED_MODELS`.
The Manager compiles only after route selection. An eligible block becomes a
native text label plus bounded image data, and OpenAI-compatible, OpenAI
Responses, and Anthropic adapters serialize that multimodal input using their
native contracts. The exact original remains authoritative and fetchable.

`pnpm evaluate:pxpipe` measures local render latency/bytes and exact recovery
without contacting a model. Results are recorded in
[`pxpipe-evaluation.json`](pxpipe-evaluation.json). That measurement does not
establish answer quality or cost benefit, so no production enablement claim is
made. `pnpm evaluate:pxpipe:hermes` runs the paired text-versus-optical quality,
provider-billed token, cache-token, cost, latency, recovery, and failure gate
through the localhost-only Hermes route described in [`TESTING.md`](TESTING.md).
The bounded result is measurement evidence, never an automatic enablement.
