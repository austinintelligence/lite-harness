# Conservative context optimization

Lite-Harness keeps a canonical exact `Context IR`. Security policy, current
state, source edits, tool schemas, and unknown-model content stay as text.
Optional pxpipe rendering is pinned to `pxpipe-proxy@0.8.0`, uses its public
`renderTextToImages` entry point, and retains exact blocks for
`context_fetch_exact` recovery.

The renderer verifies the installed package version before importing it. A
missing or mismatched version fails closed to the exact-text path instead of
running an unevaluated renderer while reporting stale provenance.

The gate has global, app, and model switches plus a tenant-scoped render cache.
Renderer error, an unknown model profile, or any disabled switch falls back to
text without changing run semantics. The feature is disabled by default.

Set `LITE_HARNESS_CONTEXT_FILE` to a bounded operator-owned instruction file to
compose canonical context into real runs. Optional rendering additionally
requires `LITE_HARNESS_CONTEXT_OPTIMIZATION=true` and explicit comma-separated
`LITE_HARNESS_CONTEXT_ALLOWED_APPS` and `LITE_HARNESS_CONTEXT_ALLOWED_MODELS`.
The Manager compiles once at run start; adapters that currently accept only the
canonical text representation receive exact text even when an optional image
view can be produced.

`pnpm evaluate:pxpipe` measures local render latency/bytes and exact recovery
without contacting a model. Results are recorded in
[`pxpipe-evaluation.json`](pxpipe-evaluation.json). That measurement does not
establish answer quality or cost benefit, so no production enablement claim is
made. Any future model-backed comparison must use the Hermes wrapper described
in [`TESTING.md`](TESTING.md).
