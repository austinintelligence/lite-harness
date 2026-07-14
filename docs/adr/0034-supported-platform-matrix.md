# ADR 0034: Supported platform and container matrix

- Status: provisional
- Date: 2026-07-14
- Covers: Research 2

## Primary sources

- Node release schedule: https://nodejs.org/en/about/previous-releases (Node 24 LTS; retrieved 2026-07-14)
- Docker Desktop for macOS: https://docs.docker.com/desktop/setup/install/mac-install/ (current and two previous macOS majors; retrieved 2026-07-14)
- Docker Desktop for Windows: https://docs.docker.com/desktop/setup/install/windows-install/ (WSL2 backend; retrieved 2026-07-14)
- Docker rootless mode: https://docs.docker.com/engine/security/rootless/ (current Docker Engine; retrieved 2026-07-14)

## Decision

The verified-alpha matrix is Node 24 LTS on Ubuntu 24.04 LTS amd64/arm64, macOS versions currently supported by Docker Desktop on Intel and Apple silicon, and Windows 11 with a current WSL2 kernel and Docker Desktop Linux containers. Ubuntu 24.04 rootless Docker is a required separate lane. Debian 12/13 and newer Linux distributions are compatible-but-unverified until evidence exists. Compose is not required.

## Alternatives considered

Rejected: Claiming all modern Linux distributions; treating WSL2 as native Windows containers; supporting macOS architectures without Docker Desktop evidence.

## Security impact

A bounded matrix makes filesystem, socket, credential-store, rootless, sleep/resume, and daemon-restart assumptions testable.

## Compatibility impact

Unlisted platforms may work but are unsupported. Alpha claims require exact OS, architecture, Docker client/server, context, and kernel evidence.

## Migration plan

Create external lanes for Linux rootful/rootless arm64, macOS Intel/Apple silicon, and Windows 11 WSL2; narrow docs automatically when a required lane is missing.

## Release impact

Provisional until every named lane has current zero-skip packaged-boundary evidence.
