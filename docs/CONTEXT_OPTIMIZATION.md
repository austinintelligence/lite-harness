# Conservative context optimization

Lite-Harness keeps a canonical exact `Context IR`. Security policy, current
state, source edits, tool schemas, and unknown-model content stay as text.
Optional pxpipe rendering is pinned to `pxpipe-proxy@0.7.1`, uses its public
`renderTextToImages` entry point, and retains exact blocks for
`context_fetch_exact` recovery.

The gate has global, app, and model switches plus a tenant-scoped render cache.
Renderer error, an unknown model profile, or any disabled switch falls back to
text without changing run semantics. The feature is disabled by default.

`pnpm evaluate:pxpipe` measures local render latency/bytes and exact recovery
without contacting a model. Results are recorded in
[`pxpipe-evaluation.json`](pxpipe-evaluation.json). That measurement does not
establish answer quality or cost benefit, so no production enablement claim is
made. Any future model-backed comparison must use the Hermes wrapper described
in [`TESTING.md`](TESTING.md).
