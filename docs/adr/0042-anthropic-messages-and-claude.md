# ADR 0042: Anthropic Messages and delegated Claude integration

- Status: accepted
- Date: 2026-07-14
- Covers: Research 10

## Primary sources

- Anthropic Messages API: https://platform.claude.com/docs/en/api/messages (current Claude API; retrieved 2026-07-14)
- Anthropic streaming: https://platform.claude.com/docs/en/build-with-claude/streaming (current SSE event model; retrieved 2026-07-14)
- Anthropic errors: https://platform.claude.com/docs/en/api/errors (current error contract; retrieved 2026-07-14)
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (current cache controls; retrieved 2026-07-14)

## Decision

Use the native Anthropic Messages API for direct Claude routes, preserving content blocks, tool-use/tool-result IDs, streaming deltas, cache accounting, usage, request IDs, overload/rate-limit semantics, and terminal errors. Treat Claude Code subscription workflows as a separately supervised delegated adapter with explicit protocol/version fixtures; never infer direct-API capability from delegated access.

## Alternatives considered

Rejected: Routing Anthropic through a lossy OpenAI-shaped adapter; treating CLI text as a protocol; assuming prompt cache writes/reads are ordinary input tokens.

## Security impact

Direct and delegated credentials remain separate; retries stop after side effects or partial output; prompt-cache and provider data behavior are visible to policy.

## Compatibility impact

Native blocks are normalized without erasing provider-specific metadata. Unsupported capabilities fail before dispatch.

## Migration plan

Complete native stream/error/cache conformance, add delegated version negotiation and cancellation, and persist normalized plus provider request metadata.

## Release impact

Direct Anthropic and delegated Claude remain preview until independent live evidence is available through an owner-approved route.
