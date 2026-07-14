# ADR 0041: OpenAI Responses and delegated Codex integration

- Status: accepted
- Date: 2026-07-14
- Covers: Research 9

## Primary sources

- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses (current Responses API; retrieved 2026-07-14)
- OpenAI streaming events: https://platform.openai.com/docs/api-reference/responses-streaming/response/function_call_arguments/done?api-mode=responses (current Responses streaming events; retrieved 2026-07-14)
- OpenAI data controls: https://platform.openai.com/docs/models/default-usage-policies-by-endpoint (current endpoint retention policy; retrieved 2026-07-14)
- Codex app-server: https://developers.openai.com/codex/app-server (stdio JSONL; WebSocket experimental; retrieved 2026-07-14)

## Decision

Use the Responses API as the native OpenAI direct route, including typed streaming events, tools, structured output, usage, incomplete/error states, request IDs, and explicit store/data-control options. Keep generic OpenAI-compatible Chat Completions as a separate compatibility route. Integrate subscription-backed Codex through supervised app-server stdio JSONL; do not depend on its experimental WebSocket transport. Local model-backed tests continue through the configured localhost Hermes proxy.

## Alternatives considered

Rejected: Treating Chat Completions as the permanent OpenAI-native contract; scraping Codex terminal output; using experimental app-server WebSocket for alpha.

## Security impact

Credentials remain in the provider/delegated supervisor; storage choices and tool approvals are explicit; app-server output is bounded and fail-closed.

## Compatibility impact

Responses, compatible chat, and delegated Codex expose normalized Lite events without pretending their native capabilities are identical.

## Migration plan

Add a Responses adapter and conformance fixtures, persist route and request IDs, supervise app-server lifecycle/version negotiation, and retain the Hermes wrapper for all local inference tests.

## Release impact

Requires live Responses-compatible and delegated Codex conformance evidence with no direct credential discovery.
