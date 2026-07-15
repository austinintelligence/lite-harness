# API and SDK

The public Gateway defaults to `http://127.0.0.1:3210`. All `/v1` routes require
`Authorization: Bearer <app token>`. Local alpha identity uses
`X-Lite-Tenant-Id` and `X-Lite-User-Id`; production authenticators must derive
these claims from trusted app identity rather than accepting arbitrary headers.

## Routes

- `GET /healthz` - Gateway liveness
- `GET /readyz` - Gateway-to-Manager readiness
- `POST /hooks/webhook/{accountId}` - signed, durable integration ingress
- `POST /v1/runs` - create or replay a run (`Idempotency-Key` recommended)
- `GET /v1/runs/{runId}` - get authorized run state
- `GET /v1/runs/{runId}/events?after=N` - replay and follow SSE events
- `GET /v1/runs/{runId}/attempts` - list durable execution attempts
- `GET /v1/runs/{runId}/children` - list owned direct child runs
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
- `POST /v1/tokens` / `DELETE /v1/tokens/{tokenId}` - mint and revoke resource-bound run tokens

Errors use the versioned envelope `{ "error": { "version": 1, "code": "...",
"message": "...", "retryable": false } }`, with optional `retryAfterMs` and
bounded `details`. Both SDKs preserve those fields in `LiteHarnessError`.
Resource ownership failures use 404. Event cursors are per-run monotonically
increasing integers; reconnect with the last received sequence.

Gateway-to-Manager traffic is a separate local contract. Every authenticated
request carries `X-Lite-IPC-Version: 1`; incompatible clients receive a typed
426 response. Manager liveness publishes the selected protocol and an opaque
instance ID. A user-only instance lock plus live-endpoint probe prevents a
contender from unlinking or replacing the active Unix socket; Unix socket mode
is restricted to the current user. Windows uses a local named pipe and the same
lock/protocol handshake.

Run creation accepts an optional `budget` object with turn, tool-call, token,
cost, total-timeout, model-idle-timeout, and command-timeout limits. Omitted
values inherit the selected agent profile defaults. `RunRecord.usage` is the
durable ledger used to enforce those limits. Runs sharing a workspace or
session execute serially, and every execution is recorded as a run attempt.

The TypeScript SDK exposes the same operations through `LiteHarnessClient`.
The prerelease Python client under `sdks/python` covers the same run, replay,
session, artifact, agent, and workspace surface.
The machine-readable contract is [`openapi.json`](openapi.json). It is generated
from the public TypeBox schemas in `packages/contracts/src/index.ts` with
`pnpm generate:openapi`; `pnpm check:openapi` fails on drift. The generated
TypeScript model and operation inventory is
`packages/sdk-typescript/src/generated-api.ts`, and the Python TypedDict model
inventory is `sdks/python/src/lite_harness/generated_api.py`. Release checks
require every public operation to expose a typed request (when applicable), a
typed success response, and matching SDK operation/model inventories.

The webhook route does not use the app bearer token. It requires
`X-Lite-Signature` and resolves a preconfigured account/sender binding inside
Manager. Its canonical envelope, connector adapters, receipts, and durable
schedule configuration are documented in [`INTEGRATIONS.md`](INTEGRATIONS.md).
