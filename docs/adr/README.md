# Architecture decision records

The 32 frozen decisions below are generated from the immutable architecture contract by `pnpm generate:adrs:frozen`. Research, support-matrix, publication, and contradiction ADRs are maintained separately after ADR 0032.

| Requirement | Decision | Status |
| --- | --- | --- |
| D01 | [Node and TypeScript implementation stack](./0001-node-typescript-stack.md) | accepted |
| D02 | [pnpm monorepo](./0002-pnpm-monorepo.md) | accepted |
| D03 | [Host-owned model and agent loop](./0003-host-agent-loop.md) | accepted |
| D04 | [Docker is the untrusted tool boundary](./0004-docker-tool-boundary.md) | accepted |
| D05 | [Separate Gateway and Manager process roles](./0005-gateway-manager-processes.md) | accepted |
| D06 | [Narrow local Gateway-to-Manager IPC](./0006-narrow-local-ipc.md) | accepted |
| D07 | [Gateway rejects raw Docker authority](./0007-gateway-no-docker-options.md) | accepted |
| D08 | [Resource-scoped public authorization](./0008-resource-scoped-authorization.md) | accepted |
| D09 | [Short-lived opaque external tokens](./0009-opaque-short-lived-tokens.md) | accepted |
| D10 | [Manager receives a resolved principal](./0010-resolved-internal-principal.md) | accepted |
| D11 | [SQLite WAL as the first database](./0011-sqlite-wal-first.md) | accepted |
| D12 | [Durable runs and events](./0012-durable-runs-events.md) | accepted |
| D13 | [Single writable run per workspace](./0013-single-workspace-writer.md) | accepted |
| D14 | [Fenced workspace leases](./0014-workspace-fencing.md) | accepted |
| D15 | [Managed named-volume workspaces](./0015-named-volume-default.md) | accepted |
| D16 | [Registered host-project developer mode](./0016-registered-bind-mounts.md) | accepted |
| D17 | [Encrypted authenticated cold snapshots](./0017-encrypted-cold-snapshots.md) | accepted |
| D18 | [Tenant-private cache ownership](./0018-tenant-private-cache.md) | accepted |
| D19 | [Docker-owned image and layer caching](./0019-docker-owned-layer-cache.md) | accepted |
| D20 | [Optional pxpipe after route selection](./0020-optional-pxpipe-after-routing.md) | accepted |
| D21 | [Exact text remains canonical context](./0021-exact-canonical-context.md) | accepted |
| D22 | [Docker containment is not a micro-VM boundary](./0022-honest-docker-containment.md) | accepted |
| D23 | [Kernel depends only on contracts](./0023-contract-only-kernel.md) | accepted |
| D24 | [Large features are lazy capability packs](./0024-lazy-capability-packs.md) | accepted |
| D25 | [Third-party plugins run out of process](./0025-out-of-process-plugins.md) | accepted |
| D26 | [Native direct APIs and delegated subscription adapters](./0026-native-direct-delegated-subscription.md) | accepted |
| D27 | [Separate app, provider, and integration authentication](./0027-separate-auth-domains.md) | accepted |
| D28 | [Opaque credential profiles](./0028-opaque-credential-profiles.md) | accepted |
| D29 | [Capability- and policy-based model routing](./0029-capability-policy-routing.md) | accepted |
| D30 | [Compile canonical requests after route selection](./0030-compile-after-route.md) | accepted |
| D31 | [OpenClaw compatibility is an adapter](./0031-openclaw-compat-adapter.md) | accepted |
| D32 | [Compatibility is defined by behavior](./0032-behavior-defined-compatibility.md) | accepted |
