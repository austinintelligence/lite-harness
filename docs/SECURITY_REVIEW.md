# Security review

Date: 2026-07-14
Scope: final Lite-owned diff from the pinned OpenClaw baseline

The release review covered public/IPC authentication, resource ownership,
SQLite queries and migrations, child-process execution, workspace and plugin
paths, credential storage/redaction, AES-GCM snapshot/profile envelopes,
provider and connector HTTP, MCP, browser SSRF/egress, artifact limits, and
dependency/provenance controls.

No critical or high-severity code finding remains in the reviewed alpha scope.
Concrete issues corrected during review included complete plugin-package
integrity hashing, bounded/cancellable provider and connector responses,
provider-stream cleanup, browser hop-by-hop header stripping and request limits,
registered-source containment, nonempty service-token enforcement, optional
memory zero-overhead, and removal of host IPC from the browser container.

Automated evidence:

- `pnpm check:secrets` scans tracked and untracked release files.
- `pnpm audit --prod --audit-level high` reports no known vulnerability.
- `pnpm check:boundaries` prevents Gateway privilege and legacy import drift.
- `pnpm check:provenance` verifies the fork baseline and third-party map.
- CI adds CodeQL, Dependabot, SBOM generation, and pinned GitHub Actions.

Residual risks are explicit rather than silently accepted: regular Docker is
not a hostile multi-tenant micro-VM; Manager and its IPC token are trusted;
operator-enabled remote CDP/private-network/plugin/connector modes expand
trust; macOS `security` CLI storage follows platform process semantics; and
Node 24's built-in SQLite remains experimental. See [`THREAT_MODEL.md`](THREAT_MODEL.md).
