# ADR 0052: Alpha scope, networking, services, and preview boundaries

- Status: accepted
- Date: 2026-07-14
- Covers: Plan contradictions: networking, breadth, service managers, WebSocket, provider/integration tiers

## Primary sources

- Architecture contract: ../../LITE_HARNESS_ARCHITECTURE_PLAN.md (reviewed baseline; retrieved 2026-07-14)
- Alpha definition: ../requirements/alpha-ledger.yaml (A01-A22; retrieved 2026-07-14)
- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (stdio and Streamable HTTP; retrieved 2026-07-14)
- Codex app-server transports: https://developers.openai.com/codex/app-server (WebSocket experimental; retrieved 2026-07-14)

## Decision

Core alpha includes compiled foreground launcher/Gateway/Manager, durable coordinator, SDKs, fake runtime, enforceable Docker tool boundary, OpenAI/OpenAI-compatible/Anthropic/Codex lanes only after conformance, stdio and Streamable HTTP MCP, managed browser only after brokered egress, snapshots/recovery, and compatibility migration. General-purpose brokered networking is not a standalone alpha API, but every alpha-enabled network capability must use enforceable broker policy. Broad providers, integrations, automation, vector memory, delegated Claude, OS service managers, and pxpipe are preview. WebSocket is not an alpha public surface; public control uses REST commands plus replayable SSE.

## Alternatives considered

Rejected: Counting preview breadth toward alpha; requiring every roadmap ecosystem item before core alpha; advertising WebSocket from unimplemented or experimental transports.

## Security impact

No networked capability is promoted without enforceable egress/auth policy, and service/background claims cannot exceed tested lifecycle evidence.

## Compatibility impact

REST+SSE, versioned IPC, and named core provider/MCP contracts are alpha surfaces. Preview packs are clearly labeled and excluded from A01-A22 evidence.

## Migration plan

Remove WebSocket promises, relabel breadth consistently, gate browser/HTTP/MCP networking, keep service generation preview, and promote each pack only through its own conformance evidence.

## Release impact

Resolves the plan contradictions without weakening A01-A22; missing core lanes still block verified alpha.
