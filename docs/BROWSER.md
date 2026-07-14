# Managed browser capability

The managed browser pack starts Chromium only when a run creates a browser
session. Chromium lives in a disposable, non-root Docker sidecar; the Gateway
and ordinary tool containers never receive CDP access.

## Build and verify the image

The Dockerfile pins both the Playwright image digest and Playwright package
version. Build it once, then pass the immutable local image ID to the driver:

```powershell
docker build -t lite-harness/browser-runtime:dev docker/browser-runtime
$env:LITE_HARNESS_TEST_BROWSER_IMAGE = docker image inspect lite-harness/browser-runtime:dev --format '{{.Id}}'
pnpm vitest run test/browser-integrations.test.ts
```

The driver rejects mutable tags. It runs the image with a read-only root,
non-root `pwuser`, all Linux capabilities dropped, no-new-privileges, bounded
memory/CPU/PIDs, a bounded temporary filesystem, and the vendored Playwright
seccomp profile.

## Contract

`ManagedBrowserBroker` creates run-owned sessions and lazily starts a
`DockerBrowserDriver`. The typed action surface includes navigation,
accessibility-oriented snapshots with stable element references, click, type,
select, hover, keyboard, bounded waits, back/forward/reload, upload,
screenshot, PDF, and quarantined download return values. Binary results are
bounded to 16 MiB and returned to the trusted host for artifact publication.

Every action can be audited with app, tenant, user, run, session, target,
decision, timestamp, and error. Idle sessions stop their sidecar automatically.

## Network policy

Only credential-free HTTP(S) URLs are accepted. The sidecar intercepts each
HTTP(S) request, resolves and validates DNS, connects to the approved address
while preserving the TLS server name, bounds redirects/body/time, and fulfills
the browser route with the brokered response. Loopback, private, link-local,
carrier-grade NAT, documentation/reserved, multicast, and metadata addresses
are denied. WebSockets are closed and non-proxied WebRTC UDP is disabled.

`allowPrivateNetworks` is a high-trust operator override. Do not enable it for
untrusted pages or tenants. Managed browser containers are Docker containment,
not a hostile multi-tenant micro-VM boundary.

Optional remote CDP is supported through a validated endpoint sent to the
sidecar over its initialization channel rather than container environment.
Owner-scoped browser profiles are encrypted with AES-GCM and generation-safe
atomic replacement. Host-session attachment, extension relay, and noVNC remain
outside the managed alpha lane because they require separate high-trust UX and
credential isolation.
