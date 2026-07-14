# API and SDK

The public Gateway defaults to `http://127.0.0.1:3210`. All `/v1` routes require
`Authorization: Bearer <app token>`. Local alpha identity uses
`X-Lite-Tenant-Id` and `X-Lite-User-Id`; production authenticators must derive
these claims from trusted app identity rather than accepting arbitrary headers.

## Routes

- `POST /v1/runs` - create or replay a run (`Idempotency-Key` recommended)
- `GET /v1/runs/{runId}` - get authorized run state
- `GET /v1/runs/{runId}/events?after=N` - replay and follow SSE events
- `POST /v1/runs/{runId}/cancel` - cancel a nonterminal run
- `POST /v1/runs/{runId}/steer` - queue an instruction for the next model turn
- `GET /v1/sessions/{sessionId}` - get session metadata
- `GET /v1/sessions/{sessionId}/messages` - get durable ordered messages
- `POST /v1/approvals/{approvalId}` - approve or deny a pending tool call
- `POST /v1/runs/{runId}/artifacts` - publish an owned artifact up to 16 MiB
- `GET /v1/artifacts/{artifactId}` - download owned artifact data and metadata

Errors use `{ "error": { "code": "...", "message": "..." } }`. Resource
ownership failures use 404. Event cursors are per-run monotonically increasing
integers; reconnect with the last received sequence.

The TypeScript SDK exposes the same operations through `LiteHarnessClient`.
The machine-readable contract is [`openapi.json`](openapi.json).
