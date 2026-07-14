# ADR 0046: Cross-platform plugin sandbox strategy

- Status: accepted
- Date: 2026-07-14
- Covers: Research 14

## Primary sources

- Docker seccomp: https://docs.docker.com/engine/security/seccomp/ (current Docker Engine; retrieved 2026-07-14)
- Docker rootless mode: https://docs.docker.com/engine/security/rootless/ (current Docker Engine; retrieved 2026-07-14)
- Docker resource constraints: https://docs.docker.com/engine/containers/resource_constraints/ (current Docker Engine; retrieved 2026-07-14)

## Decision

Executable third-party plugins use disposable restricted Linux containers on every supported host, including the Docker Desktop Linux VM on macOS/Windows. Default policy is non-root, read-only root, drop all capabilities, no-new-privileges, default/custom seccomp, pids/CPU/memory limits, no Docker socket, no host network, tmpfs scratch, allowlisted mounts, and brokered network. Native subprocess plugins are trusted-preview only and cannot satisfy the untrusted-plugin alpha gate.

## Alternatives considered

Rejected: Claiming equivalent native OS sandboxes without one enforceable cross-platform policy; in-process VM modules; unrestricted child processes.

## Security impact

Creates one auditable minimum boundary while acknowledging Docker daemon/VM trust and rootless limitations.

## Compatibility impact

Plugins target the versioned RPC/capability contract rather than host syscalls. Platform-specific native plugins are outside alpha support.

## Migration plan

Move executable plugins to the container supervisor, add permission UX and denial tests, and quarantine or relabel native adapters as trusted preview.

## Release impact

Requires escape-attempt, quota, mount, network, cleanup, and rootless evidence on the supported matrix.
