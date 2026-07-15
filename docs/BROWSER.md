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
decision, timestamp, and error. `DurableBrowserSessionStore` records sessions,
actions, and upload/download artifact links in WAL/FULL-synchronous SQLite.
Manager startup marks interrupted sessions terminal, reaps installation-labeled
browser/proxy containers and networks, and removes stale quarantine files. Idle
sessions stop their sidecar automatically and durably transition to expired.

## Artifact boundary

The model-facing upload command accepts an `artifactId`, never file bytes or a
host path. The Manager verifies app/tenant/user and workspace ownership, then
streams and authenticates the encrypted artifact into a per-session quarantine
mount. Chromium receives only the opaque quarantine ID.

Screenshots, PDFs, and downloads are written directly into that bounded mount.
The Manager rejects links and size/digest mismatches, streams the regular file
into encrypted transactional artifact storage, records the session/artifact
relationship, deletes the quarantine file, and returns only the durable
artifact record. Quarantine host paths and browser-supplied base64 never enter
tool results.

## Network policy

Only credential-free HTTP(S) URLs are accepted. Chromium joins an internal-only
Docker network and cannot route to the Internet. A separate non-root,
read-only `ExternalBrowserEgressBroker` proxy joins that network and the
external Docker bridge. It resolves and validates every destination, connects
to the approved address, and bounds tunnel bytes and idle time. Loopback, private, link-local,
carrier-grade NAT, documentation/reserved, multicast, and metadata addresses
are denied. WebSockets are closed and non-proxied WebRTC UDP is disabled.

This split is a deliberate compromise boundary: even if Chromium or its
container is compromised and ignores Playwright request hooks, it has no
external route that bypasses the policy proxy. Redirects create new proxy
requests and are checked again. TLS remains end-to-end between Chromium and the
approved origin; the proxy authorizes HTTPS by CONNECT host and pinned IP.

`allowPrivateNetworks` is a high-trust operator override. Do not enable it for
untrusted pages or tenants. Managed browser containers are Docker containment,
not a hostile multi-tenant micro-VM boundary.

Remote CDP fails closed in the managed lane because a remote browser cannot be
proven to use this external egress boundary.
Owner-scoped browser profiles are encrypted with AES-GCM and generation-safe
atomic replacement; the durable session row records the selected profile ID
without recording cookies. Host-session attachment, extension relay, and noVNC remain
outside the managed alpha lane because they require separate high-trust UX and
credential isolation.
