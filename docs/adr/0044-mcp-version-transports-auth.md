# ADR 0044: MCP version, transports, lifecycle, and auth

- Status: accepted
- Date: 2026-07-14
- Covers: Research 12

## Primary sources

- MCP overview: https://modelcontextprotocol.io/specification/2025-11-25/basic (protocol 2025-11-25; retrieved 2026-07-14)
- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (stdio and Streamable HTTP; retrieved 2026-07-14)
- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization (OAuth-based HTTP authorization; retrieved 2026-07-14)
- MCP lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle (protocol 2025-11-25; retrieved 2026-07-14)

## Decision

Target MCP 2025-11-25 with stdio and Streamable HTTP. Stdio stdout contains only JSON-RPC messages and logs use stderr. Local HTTP binds loopback, validates Origin, authenticates every connection, and enforces bounded schemas. Remote HTTP follows MCP authorization, TLS, audience binding, and no token passthrough. Legacy HTTP+SSE is compatibility-only; experimental tasks and custom transports are preview.

## Alternatives considered

Rejected: Treating old HTTP+SSE as the primary transport; unauthenticated 0.0.0.0 listeners; forwarding client bearer tokens to upstream APIs.

## Security impact

Origin checks, loopback defaults, authentication, token audience binding, schema limits, and subprocess supervision address DNS rebinding and confused-deputy risks.

## Compatibility impact

Protocol version negotiation is mandatory; unsupported versions/capabilities fail explicitly. Resources/prompts/tools retain their MCP schemas.

## Migration plan

Add 2025-11-25 initialize/capability fixtures, Streamable HTTP resume/cancel tests, OAuth metadata validation, and a bounded legacy adapter.

## Release impact

Requires real stdio and Streamable HTTP lifecycle tests; legacy and experimental features cannot satisfy core gates.
