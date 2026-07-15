# Threat model

## Protected assets

- App, provider, integration, and snapshot credentials
- Tenant sessions, workspaces, artifacts, browser profiles, and memory
- Durable run/event integrity and workspace single-writer safety
- The host Docker socket and Manager database

## Trust boundaries

- Gateway is network-facing but cannot control Docker directly.
- Manager is trusted and privileged; its local IPC token must remain private.
- Provider and plugin workers are narrower host processes.
- Tool/browser containers are disposable and untrusted.
- Regular Docker is containment, not hostile public-cloud tenant isolation.

## Enforced invariants

- Agent containers receive no permanent provider credential or Docker socket.
- Public resources are authorized by app, tenant, and user; unauthorized access
  returns not-found to avoid resource enumeration.
- Docker tool runs use a digest/image ID, non-root UID, no network, read-only
  root, dropped capabilities, no-new-privileges, and resource limits.
- Workspace write leases use monotonic fencing tokens.
- Snapshot ciphertext is authenticated before restore and the previous verified
  generation remains available.
- Provider fallback stops after a tool call becomes externally visible.
- Browser destinations reject credentials, non-HTTP protocols, private ranges,
  link-local metadata targets, and non-allowlisted origins. Chromium has only
  an internal Docker network; a separate constrained proxy is the only member
  with an external route and rechecks DNS/origin policy for every request.
- Browser uploads originate from owner/workspace-authorized encrypted artifact
  records. Browser outputs cross through an opaque, size-bounded quarantine,
  are verified as regular files, streamed into authenticated storage, and
  removed before model-visible results are formed.
- Skills cannot widen policy; plugin grants are intersections, never unions.
- Provider secrets can be resolved through the OS secret store and never enter
  run state, Gateway, or ordinary tool containers.

## Known exclusions

- A Docker/kernel escape can reach the host; use gVisor/Kata/micro-VMs for
  hostile multi-tenant execution.
- Environment-based provider/snapshot keys remain available for local use;
  shared deployments should select the OS/secret-manager broker.
- Browser private-network overrides, compatibility plugins, and connector
  workers are operator-enabled trust expansions with separate policy. Remote
  CDP is disabled until it can preserve the external egress boundary.
- Denial-of-service beyond configured local quotas is not a distributed
  fairness guarantee.
