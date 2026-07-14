# ADR 0037: Docker Engine control-plane contract

- Status: accepted
- Date: 2026-07-14
- Covers: Research 5

## Primary sources

- Docker Engine API: https://docs.docker.com/reference/api/engine/ (versioned Engine API; retrieved 2026-07-14)
- Docker object labels: https://docs.docker.com/engine/manage-resources/labels/ (current Docker Engine; retrieved 2026-07-14)
- Docker resource constraints: https://docs.docker.com/engine/containers/resource_constraints/ (current Docker Engine; retrieved 2026-07-14)
- Docker rootless mode: https://docs.docker.com/engine/security/rootless/ (current Docker Engine; retrieved 2026-07-14)

## Decision

Use the version-negotiated Docker Engine API for create/start/inspect/wait/events/stop/remove and managed volumes. Every owned object carries stable ownership labels. Apply CPU, memory, pids, read-only-root, capability, network, and mount policy at create time. Reconcile from labels and inspect state after daemon restart, host resume, or event-stream loss. Rootless is a required reduced-capability lane, not a transparent synonym for rootful.

## Alternatives considered

Rejected: Parsing human CLI output as the control contract; relying on container names alone; assuming the event stream is lossless.

## Security impact

Ownership labels and create-time constraints prevent accidental adoption/removal and limit tool authority.

## Compatibility impact

API negotiation tolerates supported Engine versions; features unavailable in rootless mode must fail closed or be declared unsupported.

## Migration plan

Centralize Docker calls in one adapter, add restart/resume reconciliation and conflict fixtures, then remove scattered CLI assumptions.

## Release impact

Requires rootful/rootless lifecycle, label-conflict, daemon-restart, and cleanup evidence.
