# Operations

`pnpm dev:launcher` starts Manager and Gateway as separate process roles under
one lifecycle. It requires distinct `LITE_HARNESS_INTERNAL_TOKEN` and
`LITE_HARNESS_APP_TOKEN` values, binds Gateway to loopback by default, writes
redacted rotating JSONL logs under the data directory, and stops the peer if
either child fails.

Use `pnpm lite service install` to store service tokens in the operating-system
secret store and emit the platform service definition. Linux uses a systemd
user unit, macOS uses a LaunchAgent, and Windows emits a startup task command.
The command does not expose a provider credential in a unit file. Inspect the
generated definition before enabling it on a shared machine.

Operational probes:

- `GET /healthz` proves the public Gateway process is alive.
- `GET /readyz` proves Gateway can authenticate to and reach Manager.
- `pnpm lite doctor` checks Node, Docker, the data directory, and service
  configuration without printing secret values.

`pnpm benchmark:kernel` performs a deterministic, model-free process/run smoke
and updates [`performance-baseline.json`](performance-baseline.json). It is not
a provider-quality benchmark. Model-backed tests must follow
[`TESTING.md`](TESTING.md).

Logs rotate by bounded byte size and generation count. Redaction covers bearer
headers and common credential shapes, but applications should still avoid
placing secrets in prompts, tool results, file names, or connector messages.
Back up the SQLite databases, artifacts, snapshots, and OS-held snapshot key as
one recovery set; see [`RECOVERY.md`](RECOVERY.md).
