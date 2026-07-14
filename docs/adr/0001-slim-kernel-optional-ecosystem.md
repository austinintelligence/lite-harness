# ADR 0001: Slim kernel, optional ecosystem

- Status: accepted
- Date: 2026-07-14

## Decision

The always-loaded kernel owns durable runs, sessions, policy, the agent loop,
capability resolution, provider routing requests, and ordered events.

Providers, browser drivers, integrations, MCP, memory implementations,
automation, and executable third-party tools are capability packs. Disabled
packs import no entry code and start no process, container, timer, socket, or
network connection.

## Consequences

- The kernel cannot import concrete provider, browser, integration, or Docker
  implementations.
- Apps are composition roots and may select concrete adapters.
- Plugin authors compile only against the public plugin SDK and contracts.
- Persistent connectors have an honest non-zero enabled idle cost.
