# ADR 0043: Provider support tiers and conformance

- Status: accepted
- Date: 2026-07-14
- Covers: Research 11 and alpha provider breadth

## Primary sources

- xAI API reference: https://docs.x.ai/docs/api-reference (current xAI API; retrieved 2026-07-14)
- OpenRouter API: https://openrouter.ai/docs/api/reference/overview (current OpenRouter API; retrieved 2026-07-14)
- Gemini function calling: https://ai.google.dev/gemini-api/docs/function-calling (current Gemini API; retrieved 2026-07-14)
- Kimi API overview: https://platform.kimi.ai/docs/api/overview (current Kimi API; retrieved 2026-07-14)
- MiniMax API: https://platform.minimax.io/docs/api-reference/text-anthropic-api (current MiniMax API; retrieved 2026-07-14)

## Decision

Alpha-supported provider lanes are fake/deterministic, OpenAI Responses, OpenAI-compatible, Anthropic Messages, and delegated Codex only after each exact lane passes capability, stream, tool, usage, cancellation, retry, and error conformance. Delegated Claude, OpenRouter, Gemini, xAI, Kimi/Moonshot, and MiniMax are preview until the same evidence exists. A preset or successful text response is not provider support.

## Alternatives considered

Rejected: Advertising every configured base URL; assuming OpenAI-compatible means tool/usage/error compatibility; counting preview providers toward alpha gates.

## Security impact

Capability admission before dispatch prevents silent tool loss, unsafe retry, credential-domain confusion, and unbounded streams.

## Compatibility impact

Each route publishes a tested capability vector and native-version notes. Preview routes may change or be removed without alpha compatibility promises.

## Migration plan

Build a shared provider conformance suite, run it live through owner-approved routes, persist results by commit/model, and promote one provider at a time.

## Release impact

Missing required direct OpenAI, Anthropic, or delegated Codex evidence keeps those external lanes NOT_QUALIFIED_EXTERNAL; it does not block Windows-local alpha, whose real-model route is the localhost Hermes proxy.
