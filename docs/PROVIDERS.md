# Providers and credentials

The currently verified Windows-local route is Hermes `gpt-5.6-luna` through
`http://127.0.0.1:8645/v1` with the non-empty local placeholder
`sk-hermes-local`. Direct OpenAI, direct Anthropic, and delegated Codex routes
remain pending live credentialed qualification and are `NOT_QUALIFIED_EXTERNAL`
for the Windows-local alpha. Do not use OpenRouter for final qualification.

Agent Runtime speaks one normalized model protocol. Model Registry filters
routes by required capabilities before cost scoring. A frozen Route Plan names
the selected model, fallbacks, registry generation, and credential profile.

Direct routes:

- OpenAI uses the first-class Responses API at the fixed official origin. It
  emits typed streaming, function-call, usage, incomplete, and error states;
  requests explicitly disable response storage and automatic truncation.
- Explicitly allowlisted OpenAI-compatible endpoints use Chat Completions as a
  separate compatibility route. This is also the route used by the local
  Hermes test proxy; selecting `openai-compatible` never silently switches to
  the native OpenAI endpoint.
- Anthropic Messages HTTP endpoint
- OpenRouter, Gemini OpenAI compatibility, xAI/Grok, Moonshot/Kimi, and MiniMax
  presets with fixed official origins (preview/future qualification only)
- Deterministic fake provider for tests and offline demos

Manager resolves `LITE_HARNESS_CREDENTIAL_PROFILE` through a single-flight
credential broker. `LITE_HARNESS_CREDENTIAL_STORE=os` reads the profile from
DPAPI on Windows, Keychain on macOS, or Secret Service on Linux. The default
`environment` lane accepts `LITE_HARNESS_PROVIDER_API_KEY` for ephemeral local
use. Headless recovery may explicitly set
`LITE_HARNESS_CREDENTIAL_RECOVERY_KEY` (at least 12 characters); this selects an
AES-GCM recovery envelope in the data directory without a plaintext fallback,
and the key is never persisted. Neither lane serializes secret material into
run state, logs, or Docker.

Fallback occurs only for typed retryable failures before the provider accepts
the request and before any text, tool call, or usage becomes visible. Once any
of those boundaries is crossed, the route is never replayed through a fallback,
preventing duplicate billing and repeated work. Unknown model IDs, prices,
capabilities, and context limits remain operator/discovery data. The three
exact GPT-5.6 IDs use a dated official standard-processing snapshot unless an
operator explicitly overrides both input and output rates:

| Model | Input / image-input MTok | Cached read MTok | Cache write MTok | Output MTok |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.6-luna` | $1.00 | $0.10 | $1.25 | $6.00 |
| `gpt-5.6-terra` | $2.50 | $0.25 | $3.125 | $15.00 |
| `gpt-5.6-sol` | $5.00 | $0.50 | $6.25 | $30.00 |

Sources: [OpenAI GPT-5.6 launch and caching terms](https://openai.com/index/gpt-5-6/)
and the [OpenAI model catalog](https://developers.openai.com/api/docs/models),
retrieved 2026-07-14. The model catalog describes text and image as input
modalities under one input-token price, so image tokens use that model's input
rate. Requests above 272,000 input tokens use the published 2x input and 1.5x
output long-context multipliers for the full request.

At run start the Manager derives required capabilities from the stored agent
profile, freezes one route for that run attempt before compiling model-specific
context, and records the registry
generation, selected/fallback model IDs, credential profile ID, and actual
per-turn usage in SQLite. `LITE_HARNESS_MODEL_CATALOG` may provide a bounded
JSON array of same-provider model records (`id`, `capabilities`,
`contextWindow`, optional prices, and `enabled`) when an installation routes
between more than one model. Catalog records reference the Manager-owned
credential profile; they never contain credentials.

Because every run has a dollar ceiling, direct routes require a complete price
record: either the exact official snapshot above or both
`LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION` and
`LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION`. Unknown pricing fails before
credential resolution or provider I/O. Adapter usage without cost is priced
locally from the frozen model rates; if the provider reports a higher cost, the
higher value is enforced. A zero rate is valid only for an operator-confirmed
zero-marginal-cost local or subscription proxy.

The durable usage ledger stores provider input/output, cached-read,
cache-write, and image token categories plus the exact USD price snapshot used
for local enforcement. If an adapter omits a category, Lite-Harness records no
invented count. Image tokens are never charged twice: they are a categorized
subset of total provider input tokens.

Direct adapters parse true SSE incrementally, bound response sizes and idle
time, normalize usage, and reject endpoints outside their configured origins.
Credential-bearing Anthropic endpoints require HTTPS unless the allowlisted
host is loopback; embedded URL credentials are rejected.
`codex` and `claude` are separate delegated process routes; subscription login
remains owned by each official runtime.

Maintainer model-backed tests use the local Hermes policy documented in
[`TESTING.md`](TESTING.md). Deterministic unit tests remain credential-free.
