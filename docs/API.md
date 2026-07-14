# API and SDK

The public Gateway defaults to `http://127.0.0.1:3210`. All `/v1` routes require
`Authorization: Bearer <app token>`. Local alpha identity uses
`X-Lite-Tenant-Id` and `X-Lite-User-Id`; production authenticators must derive
these claims from trusted app identity rather than accepting arbitrary headers.

## Routes

- `POST /hooks/webhook/{accountId}` - signed, durable integration ingress
- `POST /v1/runs` - create or replay a run (`Idempotency-Key` recommended)
- `GET /v1/runs/{runId}` - get authorized run state
- `GET /v1/runs/{runId}/events?after=N` - replay and follow SSE events
- `GET /v1/runs/{runId}/attempts` - list durable execution attempts
- `POST /v1/runs/{runId}/cancel` - cancel a nonterminal run
- `POST /v1/runs/{runId}/steer` - queue an instruction for the next model turn
- `GET /v1/sessions/{sessionId}` - get session metadata
- `GET /v1/sessions/{sessionId}/messages` - get durable ordered messages
- `POST /v1/approvals/{approvalId}` - approve or deny a pending tool call
- `POST /v1/runs/{runId}/artifacts` - publish an owned artifact up to 16 MiB
- `GET /v1/artifacts/{artifactId}` - download owned artifact data and metadata
- `POST /v1/agents` / `GET /v1/agents` - create and list owned agent profiles
- `GET /v1/agents/{agentId}` - get an owned agent profile
- `POST /v1/workspaces` / `GET /v1/workspaces` - create and list managed workspaces
- `GET /v1/workspaces/{workspaceId}` - get an owned workspace

Errors use `{ "error": { "code": "...", "message": "..." } }`. Resource
ownership failures use 404. Event cursors are per-run monotonically increasing
integers; reconnect with the last received sequence.

Run creation accepts an optional `budget` object with turn, tool-call, token,
cost, total-timeout, model-idle-timeout, and command-timeout limits. Omitted
values inherit the selected agent profile defaults. `RunRecord.usage` is the
durable ledger used to enforce those limits. Runs sharing a workspace or
session execute serially, and every execution is recorded as a run attempt.

The TypeScript SDK exposes the same operations through `LiteHarnessClient`.
The machine-readable contract is [`openapi.json`](openapi.json).

The webhook route does not use the app bearer token. It requires
`X-Lite-Signature` and resolves a preconfigured account/sender binding inside
Manager. Its canonical envelope, connector adapters, receipts, and durable
schedule configuration are documented in [`INTEGRATIONS.md`](INTEGRATIONS.md).
