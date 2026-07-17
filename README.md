# Lite-Harness

Lite-Harness is a local-first, application-embeddable agent platform built as
an actual GitHub fork of OpenClaw. It preserves OpenClaw ancestry and selected
user-facing behavior while replacing the internal module graph with a small,
Lite-owned kernel and lazy capability packs.

> **Naming:** Lite-Harness is still a codename. Another public project uses a
> similar name. Do not publish npm packages, domains, or branding under this
> name until the collision is resolved.

## What works today

- Separate authenticated Gateway and privileged Manager process roles
- Durable SQLite agents, workspaces, runs, attempts, sessions, messages,
  approvals, usage ledgers, and ordered event replay
- Idempotent run creation, cancellation, steering, restart reconciliation, and
  one-writer workspace/session queues and leases with monotonic fencing tokens
- Agent-default and per-run turn/tool/token/cost budgets plus total,
  model-idle, and command timeouts
- Host-side provider plane with capability-aware routing, opaque credential
  profiles, normalized usage/errors, and side-effect-safe fallback
- Fake, OpenAI-compatible, Anthropic, OpenRouter, Gemini, xAI, Kimi, and
  MiniMax direct provider routes with incremental streaming
- Official Codex app-server and Claude Code delegated process adapters with
  bounded supervision, cancellation, normalized events, and fail-closed actions
- Hardened digest-pinned Docker tool runtime with persistent named volumes
- Authenticated encrypted snapshots, previous-generation recovery, and owned
  artifact publish/download
- Thin TypeScript SDK and replayable SSE
- Manifest-first staged plugins, deterministic SKILL.md snapshots, isolated
  MCP stdio/remote-HTTP supervision, and bounded Plugin Host compatibility RPC
- On-demand managed Chromium in a digest-pinned, non-root Docker sidecar with
  run-owned sessions, stable refs, typed actions, bounded binary artifacts,
  private-network policy, action audit, and idle cleanup
- Signed webhook-to-run ingress with durable bindings/receipts/dedupe/replies,
  native Telegram/Discord/Slack verification and outbound adapters, and an
  opt-in restart-safe time-zone-aware scheduler
- Subagent graphs, offline FTS memory, and conservative exact-recoverable
  context rendering integrated as brokered Manager capabilities
- OS-backed credentials, a unified launcher, service definitions, rotating
  redacted logs, OpenClaw migration tooling, deterministic SBOM generation,
  repository hygiene checks, release-gated image workflows, and TypeScript plus
  Python prerelease SDKs
- Windows, macOS, and Linux CI definitions; real Docker lifecycle tests are
  environment-gated and have been exercised on Docker Desktop/WSL2

Optional packs have explicit support tiers and do not imply that every
OpenClaw connector or plugin has been ported. See
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for precise
support labels.

## Architecture

```text
App / TypeScript SDK
        |
        v
Lite Gateway  -- authenticated local IPC -->  Harness Manager
                                                    |
                     +------------------------------+--------------------+
                     |                              |                    |
               Provider plane                Plugin workers       Docker runtime
                     |                              |                    |
              Model APIs /                  Optional packs         Named-volume
             delegated agents          (skills/MCP/browser/...)     workspaces
```

The Gateway never receives Docker options and never imports Docker, storage,
provider credentials, or Manager internals. Provider keys, snapshot keys, the
database, and the Docker socket never enter ordinary tool containers.

## Requirements

- Node.js 24
- pnpm 11.7.0 through Corepack
- Docker Desktop/Engine for Docker-backed runs

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Build release-shaped artifacts with `pnpm build:all`. The output includes an
installable compiled application tarball, packed contracts and TypeScript SDK
tarballs, plus Python wheel and sdist under `dist/`. The command `pnpm
check:artifacts --python-wheel` installs those packages into clean temporary environments and
runs both SDKs through separate compiled Gateway and Manager processes over the
real local IPC endpoint. The smoke deliberately uses explicit deterministic
fake provider/runtime selections; production startup never silently chooses
them.

Build the pinned local tool image and record its immutable image ID:

```powershell
docker build -t lite-harness/tool-runtime:dev docker/tool-runtime
$env:LITE_HARNESS_RUNTIME_IMAGE = docker image inspect lite-harness/tool-runtime:dev --format '{{.Id}}'
```

The browser pack has a separate, lazy image and does not need to be built for
ordinary runs:

```powershell
docker build -t lite-harness/browser-runtime:dev docker/browser-runtime
$env:LITE_HARNESS_TEST_BROWSER_IMAGE = docker image inspect lite-harness/browser-runtime:dev --format '{{.Id}}'
pnpm vitest run test/browser-integrations.test.ts -t "runs the pinned Chromium sidecar"
```

See [`docs/BROWSER.md`](docs/BROWSER.md),
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md), and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Run locally

Use separate random values for public app authentication and internal IPC:

```powershell
$env:LITE_HARNESS_INTERNAL_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
$env:LITE_HARNESS_APP_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
$env:LITE_HARNESS_MODE = 'development'
$env:LITE_HARNESS_RUNTIME = 'docker'
$env:LITE_HARNESS_PROVIDER = 'fake'
pnpm dev:manager
```

In a second terminal, set the same two token values and run:

```powershell
pnpm dev:gateway
```

Create a run through the TypeScript SDK:

```ts
import { LiteHarnessClient } from "@lite-harness/sdk";

const lite = new LiteHarnessClient({
  baseUrl: "http://127.0.0.1:3210",
  token: process.env.LITE_HARNESS_APP_TOKEN!,
  tenantId: "tenant-demo",
  userId: "user-demo",
});

const run = await lite.createRun({
  agent: "coder",
  workspace: "demo",
  input: "Create hello.txt",
  budget: { maxTurns: 6, totalTimeoutMs: 300_000 },
});

for await (const event of lite.events(run.runId)) {
  console.log(event.sequence, event.type, event.payload);
}
```

## Real providers

Provider credentials remain in Manager. They are never forwarded to Docker.

```powershell
$env:LITE_HARNESS_PROVIDER = 'openai'
$env:LITE_HARNESS_MODEL = 'your-supported-model-id'
$env:LITE_HARNESS_MODEL_INPUT_USD_PER_MILLION = 'set-current-input-rate'
$env:LITE_HARNESS_MODEL_OUTPUT_USD_PER_MILLION = 'set-current-output-rate'
$env:LITE_HARNESS_PROVIDER_API_KEY = 'set-in-your-secret-manager-or-shell'
```

Use `anthropic` for Anthropic or `openai-compatible` plus
`LITE_HARNESS_PROVIDER_BASE_URL` for an explicitly configured compatible
endpoint. Presets also cover `openrouter`, `gemini`, `xai`, `kimi`, and
`minimax`. Set `LITE_HARNESS_CREDENTIAL_STORE=os` to resolve
`LITE_HARNESS_CREDENTIAL_PROFILE` through DPAPI, Keychain, or Secret Service.
For headless recovery, explicitly set
`LITE_HARNESS_CREDENTIAL_RECOVERY_KEY` (at least 12 characters) to use an
encrypted recovery envelope in the data directory; the key is not persisted
and there is no plaintext fallback.

For a fail-closed offline run, set `LITE_HARNESS_OFFLINE=true`. Offline mode
accepts the deterministic fake provider in development or an
`openai-compatible` provider at a loopback HTTP(S) URL. It rejects browser and
callback egress plus non-loopback HTTP MCP servers. Runtime, MCP, plugin, and
browser Docker launches use only preloaded digest-pinned images
(`--pull=never`); missing images fail instead of being downloaded.

For trusted owner-local delegated execution, use `codex` or `claude` as
`LITE_HARNESS_PROVIDER`; see
[`docs/DELEGATED_RUNTIMES.md`](docs/DELEGATED_RUNTIMES.md). Subscription
credentials remain owned by the official runtime and are never treated as
general API keys.

## Workspace recovery

Generate a 32-byte snapshot key once and store it outside the repository:

```powershell
$env:LITE_HARNESS_SNAPSHOT_KEY = pnpm lite keygen
pnpm lite workspace snapshot demo
pnpm lite workspace restore demo
```

Docker-backed runs checkpoint automatically. Set
`LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT=true` only when verified snapshots
should replace warm volumes with cold storage after each run.

See [`docs/RECOVERY.md`](docs/RECOVERY.md) before deleting a volume.
Derived caches use fenced, immutable, owner-scoped generations; see
[`docs/CACHES.md`](docs/CACHES.md).

## Security and release gates

```powershell
pnpm verify
pnpm release:check
pnpm lite doctor
```

Model-backed maintainer tests use the local policy in
[`docs/TESTING.md`](docs/TESTING.md); credential-free verification remains
deterministic. Architecture support/evidence boundaries are recorded in
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

Regular Docker is a local containment boundary, not a hostile multi-tenant
micro-VM. Read [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and
[`SECURITY.md`](SECURITY.md) before exposing the service beyond localhost.

## Fork and provenance

- Upstream: [`openclaw/openclaw`](https://github.com/openclaw/openclaw)
- Frozen baseline: `834810b3d6e367cbdf69b4c822d220f1a150b14c`
- Lite default branch: `lite-main`
- Read-only baseline branch/tag: `upstream-snapshot` / `openclaw-baseline`

Adapted upstream code must update `PROVENANCE.json` and
`THIRD_PARTY_NOTICES.md`. The target architecture and staged transformation
are documented in [`LITE_HARNESS_ARCHITECTURE_PLAN.md`](LITE_HARNESS_ARCHITECTURE_PLAN.md).

## License

MIT. Upstream and third-party notices remain in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
