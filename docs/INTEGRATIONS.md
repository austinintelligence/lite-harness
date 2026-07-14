# Integrations and automation

Lite-Harness normalizes inbound work into one durable envelope and routes it
through the same Run service as API-created work. Connector credentials are a
separate security domain from app, model-provider, and workspace authority.

## Built-in webhook

Enable the webhook ingress by setting `LITE_HARNESS_WEBHOOK_SECRET`. Optional
binding variables are:

- `LITE_HARNESS_WEBHOOK_ACCOUNT` (default `primary`)
- `LITE_HARNESS_WEBHOOK_SENDER` (default wildcard)
- `LITE_HARNESS_WEBHOOK_APP_ID`, `LITE_HARNESS_WEBHOOK_TENANT_ID`, and
  `LITE_HARNESS_WEBHOOK_USER_ID`
- `LITE_HARNESS_WEBHOOK_AGENT_ID`, `LITE_HARNESS_WEBHOOK_WORKSPACE_ID`, and
  `LITE_HARNESS_WEBHOOK_SESSION_PREFIX`

Send `POST /hooks/webhook/{accountId}` with a JSON envelope and an
`X-Lite-Signature: sha256=<hex>` header. The signature is HMAC-SHA256 over the
canonical compact JSON bytes (`JSON.stringify(envelope)`), using UTF-8. The
Gateway never accepts app identity from this unauthenticated route; Manager
resolves the preconfigured binding after signature verification.

Required envelope fields are `deliveryId`, `senderExternalId`, and `text`.
Optional fields include `conversationExternalId`, `threadExternalId`,
`attachmentUrls`, and `receivedAt`. Deliveries, receipts, bindings, and the
resulting run ID persist in SQLite, so duplicate delivery after restart returns
the original run rather than starting another.

## Native connector primitives

The integration package includes fixed-origin outbound adapters and native
request verification for Telegram, Discord, and Slack:

- Telegram secret-token verification and Bot API message delivery
- Discord Ed25519 request verification and Bot API message delivery
- Slack v0 timestamped HMAC verification and `chat.postMessage` delivery

Messages enforce provider text limits, hide network error details that could
contain credentials, classify rate limits/retryability, and never let a
connector credential authorize model or workspace access. Long-running
polling/WebSocket workers and interactive approval rendering remain separate
optional workers; the current built-in lane is webhook/API driven and has zero
idle process cost.

`DeliveryCoordinator` leases pending receipts after restart and sends one
terminal reply with a stable idempotency key. Webhook callbacks are fixed by
operator configuration and HMAC signed. A receiver must deduplicate that key to
cover the unavoidable crash window between remote acceptance and local receipt
commit. Attachment URLs are rendered as untrusted references and never grant
network authority. Signed app callbacks expose the same bounded pattern to
application-defined tools.

## Durable schedules

Manager enables the scheduler only when `LITE_HARNESS_SCHEDULES_JSON` is set.
The value is an array of interval or one-shot schedules:

```json
[
  {
    "id": "hourly-review",
    "intervalMs": 3600000,
    "jitterMs": 30000,
    "agent": "coder",
    "workspace": "operations",
    "session": "hourly-review",
    "input": "Review the current queue and summarize actionable failures.",
    "principal": { "appId": "ops", "tenantId": "local", "userId": "scheduler" }
  }
]
```

Definitions, next-fire times, firing history, leases, and errors persist in a
dedicated SQLite database. Restart preserves an existing next-fire time.
Firing uses a deterministic idempotency key derived from trigger and occurrence,
and overlapping scheduler ticks cannot claim the same occurrence. Failures are
released for bounded retry. Disabled automation starts no timer or database.

Daily schedules add `timeZone` (IANA name), `localTime` (`HH:mm`), and
`missedRunPolicy` (`skip` or `catch-up`). Nonexistent DST wall times advance to
the next valid day; repeated wall times produce one occurrence.
