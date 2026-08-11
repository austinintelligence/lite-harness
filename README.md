# Lite-Harness

Build agent systems that can survive real work.

Lite-Harness is a local-first runtime for AI agents that need durable runs, streaming events, tools, budgets, and recovery. It is an application-embeddable fork of [OpenClaw](https://github.com/openclaw/openclaw) with a smaller Lite-owned kernel and optional capability packs.

The simple idea is: an agent run should be something you can inspect, pause, resume, recover, and explain—not just a request that disappears when a process exits.

> **Project status:** Lite-Harness is an active engineering project and still uses a codename. Another public project has a similar name, so npm packages, domains, and permanent branding should wait until that collision is resolved. Support levels for optional packs are recorded in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

## What it gives an application

- **Durable runs:** agents, workspaces, attempts, sessions, messages, approvals, usage, and ordered events live in SQLite instead of only in memory.
- **Streaming you can replay:** clients can follow a run as it happens and reconstruct what happened later through the event log.
- **Bounded execution:** per-run budgets, timeouts, cancellation, steering, and one-writer workspace/session leases keep work from running away.
- **Pluggable tools:** skills, MCP connections, browser sessions, delegated runtimes, and Docker-backed tools are loaded as capabilities rather than being tangled into the core.
- **Provider flexibility:** use supported model APIs, OpenAI-compatible endpoints, or trusted local/delegated runtimes through one host-side provider plane.
- **Recovery and artifacts:** checkpoint workspaces, restore previous generations, and publish owned artifacts without putting credentials or Docker control inside ordinary tool containers.

This is aimed at people building an agent product, service, or internal platform. If you only need one model call, a smaller SDK will probably be a better fit.

## How the pieces fit

```text
Your app or SDK
       |
       v
Lite Gateway  -- authenticated local IPC -->  Harness Manager
                                                   |
                     +-----------------------------+------------------+
                     |                             |                  |
               Model providers                 Tool packs       Docker runtimes
               and delegated agents          skills / MCP /     workspaces / browser
                                             browser / web
```

The Gateway handles the application-facing surface. The Manager owns privileged state: providers, storage, credentials, workspaces, and runtime supervision. This separation keeps the public API small and makes the trust boundary easier to reason about.

## Start locally

Requirements:

- Node.js 24;
- pnpm 11.7.0 through Corepack;
- Docker Desktop or Docker Engine for Docker-backed runs.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

For a deterministic local development run, start the Manager and Gateway separately:

```powershell
$env:LITE_HARNESS_INTERNAL_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
$env:LITE_HARNESS_APP_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
$env:LITE_HARNESS_MODE = 'development'
$env:LITE_HARNESS_RUNTIME = 'docker'
$env:LITE_HARNESS_PROVIDER = 'fake'
pnpm dev:manager
```

In a second terminal, set the same token values and run:

```powershell
pnpm dev:gateway
```

Build the release-shaped artifacts with `pnpm build:all`, or use `pnpm lite doctor` to inspect the local setup.

## A small SDK example

```ts
import { LiteHarnessClient } from "@lite-harness/sdk";

const lite = new LiteHarnessClient({
  baseUrl: "http://127.0.0.1:3210",
  token: process.env.LITE_HARNESS_APP_TOKEN!,
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

The example uses the fake provider so it can be exercised without a paid model account. Real providers and credential stores are documented separately; never paste a live key into a repository or an ordinary tool container.

## What is intentionally separate

Browser automation, MCP, provider credentials, Docker, snapshots, and delegated Codex or Claude runtimes are optional capabilities. The core does not pretend that every OpenClaw connector has been ported. Read the support labels before designing around one.

Regular Docker is a local containment boundary, not a hostile multi-tenant micro-VM. Read [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and [`SECURITY.md`](SECURITY.md) before exposing the service beyond localhost.

## Documentation

Start with [`docs/README.md`](docs/README.md). The most useful paths are:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the deeper runtime design;
- [`docs/API.md`](docs/API.md) — application-facing API details;
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — providers, webhooks, and messaging integrations;
- [`docs/BROWSER.md`](docs/BROWSER.md) — the optional managed browser pack;
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) and [`docs/RECOVERY.md`](docs/RECOVERY.md) — running and recovering a deployment;
- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) — what is complete, partial, experimental, or planned;
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — security boundaries and assumptions.

## Fork and provenance

Lite-Harness keeps its OpenClaw ancestry visible:

- upstream: [`openclaw/openclaw`](https://github.com/openclaw/openclaw);
- frozen baseline: `834810b3d6e367cbdf69b4c822d220f1a150b14c`;
- Lite default branch: `lite-main`;
- read-only baseline branch/tag: `upstream-snapshot` / `openclaw-baseline`.

Adapted upstream code must update [`PROVENANCE.json`](PROVENANCE.json) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The transformation plan is recorded in [`LITE_HARNESS_ARCHITECTURE_PLAN.md`](LITE_HARNESS_ARCHITECTURE_PLAN.md).

## License

MIT. Upstream and third-party notices remain in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

