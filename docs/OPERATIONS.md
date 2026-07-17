# Operations

`pnpm dev:launcher` starts Manager and Gateway as separate process roles under
one lifecycle. It requires distinct `LITE_HARNESS_INTERNAL_TOKEN` and
`LITE_HARNESS_APP_TOKEN` values, binds Gateway to loopback by default, writes
redacted rotating JSONL logs under the data directory, and stops the peer if
either child fails.

Core process configuration has schema version 1. `LITE_HARNESS_PROVIDER` and
`LITE_HARNESS_RUNTIME` are mandatory for Manager startup; fake implementations
are available only in explicit `LITE_HARNESS_MODE=development`. Production mode
is the default and rejects either fake implementation. Ports, hosts, tokens, socket paths,
and config versions are validated before Manager opens durable state. Manager
holds `<data-dir>/manager.lock`, refuses a live owner, reclaims only a proven
dead owner, and removes only its own endpoint on shutdown.

Run `pnpm lite init` once per data directory. It writes the versioned,
non-secret `installation.json`, initializes the default owner/agent/workspace,
stores service and snapshot references in the operating-system secret store,
and prints the bootstrap client credential only on first initialization. The
credential is never written to `installation.json`; store it securely and
rotate it before sharing the machine. `pnpm lite start` installs and starts
the user service when its definition is absent. `pnpm lite service install`
can be used explicitly to inspect or reinstall that definition. Linux uses a
systemd user unit, macOS uses a LaunchAgent, and Windows uses a least-privilege
Task Scheduler task that is started after creation. Service definitions contain
no provider credential or bearer token.

`pnpm lite config get|set|list|validate` operates only on the durable
non-secret allowlist. `pnpm lite status`, `logs`, `stop`, and `doctor` use the
same persisted data directory and effective configuration as the services.
The default Windows Manager pipe is derived from the canonical data-directory
identity; an explicit `LITE_HARNESS_MANAGER_SOCKET` override remains supported.

Operational probes:

- `GET /healthz` proves the public Gateway process is alive.
- `GET /readyz` proves Gateway can authenticate to Manager and that Manager's
  database, writable disk budget, configured provider credential or delegated
  command, Docker engine, pinned runtime image, and production snapshot key are ready.
- `pnpm lite doctor` checks Node, Docker, the data directory, and service
  configuration without printing secret values.

`pnpm lite workspace register <id> <absolute-path>` is the only host-project
bind registration surface. It resolves the canonical directory before storing
it and rejects filesystem roots, whole user homes, system directories, and
credential-bearing home subdirectories. Manager reapplies the same policy when
a persisted bind is consumed, so a stale or manually altered database row does
not bypass registration policy. Managed Docker volumes remain the default.

`pnpm benchmark:kernel` performs a deterministic, model-free process/run smoke
and updates [`performance-baseline.json`](performance-baseline.json). It is not
a provider-quality benchmark. Model-backed tests must follow
[`TESTING.md`](TESTING.md).

Logs rotate by bounded byte size and generation count. Redaction covers bearer
headers and common credential shapes, but applications should still avoid
placing secrets in prompts, tool results, file names, or connector messages.
Back up the SQLite databases, artifacts, snapshots, and OS-held snapshot key as
one recovery set; see [`RECOVERY.md`](RECOVERY.md) and
[`ARTIFACTS.md`](ARTIFACTS.md).

Cache generations are disposable and must not be included as authoritative
recovery data. Their publication, verification, read leases, and quota/LRU
collection are documented in [`CACHES.md`](CACHES.md).
