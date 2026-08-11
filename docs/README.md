# Lite-Harness documentation

The root [`README.md`](../README.md) explains the project in plain language. This directory contains the deeper material for building, integrating, operating, and reviewing it.

## Choose a path

### I want to understand the design

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime boundaries and major components.
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — current support levels and evidence.
- [`LITE_HARNESS_ARCHITECTURE_PLAN.md`](../LITE_HARNESS_ARCHITECTURE_PLAN.md) — the broader transformation plan.

### I want to build an integration

- [`API.md`](API.md) — Gateway and SDK surface.
- [`INTEGRATIONS.md`](INTEGRATIONS.md) — providers, webhooks, and messaging adapters.
- [`BROWSER.md`](BROWSER.md) — managed browser sessions and artifacts.
- [`DELEGATED_RUNTIMES.md`](DELEGATED_RUNTIMES.md) — trusted Codex and Claude process adapters.

### I want to run or recover it

- [`OPERATIONS.md`](OPERATIONS.md) — local and deployment operations.
- [`RECOVERY.md`](RECOVERY.md) — snapshots, restores, and workspace recovery.
- [`ARTIFACTS.md`](ARTIFACTS.md) and [`CACHES.md`](CACHES.md) — artifact and cache lifecycles.

### I want to review safety or release readiness

- [`THREAT_MODEL.md`](THREAT_MODEL.md) — what the local Docker boundary does and does not protect against.
- [`TESTING.md`](TESTING.md) — deterministic and maintainer-only verification.
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — current release-readiness evidence and support boundaries.
- [`SECURITY.md`](../SECURITY.md) — private vulnerability reporting.

The `adr/`, `requirements/`, and `evidence/` directories preserve project decisions and implementation evidence. They are useful when you need the history behind a design, not just the current usage path.
