# Providers and credentials

Agent Runtime speaks one normalized model protocol. Model Registry filters
routes by required capabilities before cost scoring. A frozen Route Plan names
the selected model, fallbacks, registry generation, and credential profile.

Direct alpha routes:

- OpenAI and explicitly allowlisted OpenAI-compatible HTTP endpoints
- Anthropic Messages HTTP endpoint
- OpenRouter, Gemini OpenAI compatibility, xAI/Grok, Moonshot/Kimi, and MiniMax
  presets with fixed official origins
- Deterministic fake provider for tests and offline demos

Manager resolves `LITE_HARNESS_CREDENTIAL_PROFILE` through a single-flight
credential broker. `LITE_HARNESS_CREDENTIAL_STORE=os` reads the profile from
DPAPI on Windows, Keychain on macOS, or Secret Service on Linux. The default
`environment` lane accepts `LITE_HARNESS_PROVIDER_API_KEY` for ephemeral local
use. Neither lane serializes secret material into run state, logs, or Docker.

Fallback occurs only for typed retryable failures before the provider accepts
the request and before any text, tool call, or usage becomes visible. Once any
of those boundaries is crossed, the route is never replayed through a fallback,
preventing duplicate billing and repeated work. Model IDs, prices, capabilities,
and context limits are operator/discovery data, not hard-coded aliases disguised
as compatibility.

Because every run has a dollar ceiling, direct routes require both
`LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION` and
`LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION`. Unknown pricing fails before
credential resolution or provider I/O. Adapter usage without cost is priced
locally from the frozen model rates; if the provider reports a higher cost, the
higher value is enforced. A zero rate is valid only for an operator-confirmed
zero-marginal-cost local or subscription proxy.

Direct adapters parse true SSE incrementally, bound response sizes and idle
time, normalize usage, and reject endpoints outside their configured origins.
`codex` and `claude` are separate delegated process routes; subscription login
remains owned by each official runtime.

Maintainer model-backed tests use the local Hermes policy documented in
[`TESTING.md`](TESTING.md). Deterministic unit tests remain credential-free.
