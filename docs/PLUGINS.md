# Plugins, skills, and MCP

Plugins use `lite-plugin.json` with schema version, stable ID/version, relative
entry, trust class, and declared permissions. Manifest inspection reads JSON
and validates paths; it does not execute the entry. Operator grants are
intersected with declarations.

`LazyPluginSupervisor` starts a worker on first invocation, applies an
invocation timeout, clears failed workers, and stops idle workers. Production
third-party entries should use the isolated process worker protocol; trusted
in-process factories are for reviewed built-ins and tests.

SKILL.md discovery bounds bytes, frontmatter, prompt characters, recursion,
and candidate count and ignores symlinks. Startup reads only bounded manifests
and streams each selected file into a content-addressed, read-only generation;
`skill_view` is the first operation that decodes the selected instruction body.
Source-tier precedence is run, workspace, app/tenant, installed pack, then
built-in, with configured precedence used only inside a tier. Exact catalog and
content digests are attached to run-visible tool results. Requested tools,
capabilities, and permissions are eligibility metadata and never grant authority.
Before the first model turn, the context boundary writes the exact eligible
name/digest set to `skill-run-snapshots.sqlite`; a later attempt to bind a
different generation to the same owned run fails instead of mutating replay.

MCP servers are registered as lazy transports behind `BrokeredMcpToolPolicy`.
The exact static schema is validated before it can become a normal advertised
tool, and the run's ordinary allowed-tool set remains authoritative. Payloads,
schemas, server lists, time, and cancellation are bounded; a timeout, malformed
schema, oversized response, abort, or crash stops only that server.

Production stdio MCP never starts the configured command on the host. It runs
inside a digest-pinned Docker image with no network, read-only root, non-root
UID, dropped capabilities, no-new-privileges, explicit seccomp, bounded
CPU/memory/PIDs/tmpfs, no inherited host environment, no host cwd, and no
mounts or Docker socket. The exported direct stdio transport exists only for
protocol fixtures and reviewed embedding code, not Manager composition. Remote
HTTP MCP remains a Manager-owned client restricted to an exact HTTPS (or
loopback HTTP) origin; credentials are resolved only at request time.

Process-backed plugins use bounded JSON-RPC 2.0 with `initialize`, `health`,
`invoke`, `migrate`, and `shutdown`. The atomic install lock records source,
version, digest, trust class, exact operator grants, enablement, and install
time. Installs copy into a staging generation, verify the digest and worker
health, then atomically enable; failure leaves the previous generation active.
`pnpm lite plugin inspect|install|enable|disable|uninstall|migrate|doctor`
exposes the lifecycle. The lock digest covers the complete bounded package
tree, and activating an upgrade disables the previous generation only after
the new worker passes health verification.
The compatibility host loads only the documented narrow worker ABI, never an
OpenClaw Gateway route or internal SDK import.

MCP stdio workers implement the `2025-11-25` lifecycle with negotiated fallback
to supported earlier revisions, `tools/list`, `tools/call`, include/exclude
filters, per-call payload/time limits, idle shutdown, and per-server crash
isolation. Unbrokered server-to-client requests fail closed.

Remote MCP uses the same bounded request/response lifecycle over an explicitly
allowlisted HTTP origin. Credentials remain in Manager-owned configuration and
are not exposed to the model, Gateway, or tool container.

## Production Manager composition

Optional systems are disabled by default. The Manager composes them before a
run freezes its advertised tools and stops every active supervisor during
shutdown:

When every optional setting is absent, Manager does not import optional pack
runtime modules, register their schemas, create their storage roots, or start
workers, timers, sockets, processes, or containers. Type-only imports are
erased at build time. `pxpipe-proxy` remains an optional root dependency and is
loaded only after the explicit context-renderer gate is enabled.

- `LITE_HARNESS_SKILL_ROOTS` is a JSON array of `{root, precedence, source,
  sourceVersion, visibilityScope}` entries. Non-public app, user, workspace,
  run, and OpenClaw-import roots require an explicit scope such as
  `tenant:tenant_local`; built-in and installed-pack roots default to `public`.
  `skill_list` returns eligible manifests only, and `skill_view` verifies the
  immutable digest before loading one body. `LITE_HARNESS_SKILL_CAPABILITIES`
  is the comma-separated operator capability gate.
- `LITE_HARNESS_MCP_SERVERS` is a JSON array of stdio or HTTP server records.
  Every record declares its advertised tool schemas up front. Stdio records
  require `image` pinned by SHA-256 plus the in-image `command` and `args`; host
  `cwd`, `env`, and inherited environment are rejected. Transports start only
  when one of those brokered tools is invoked.
- `LITE_HARNESS_ENABLE_PLUGINS=true` activates enabled entries from
  `plugins.lock.json`. `LITE_HARNESS_PLUGIN_IMAGE` must be a digest-pinned
  sandbox image; workers remain lazy and receive only intersected grants.
- Managed Docker workspaces checkpoint and restore through Manager's fenced
  lifecycle automatically. Snapshot paths and publication are not model tools.
- `LITE_HARNESS_ENABLE_CACHE_CATALOG=true` registers owner-derived cache
  generation resolution without returning host paths to a model or container.

MCP authorization values are referenced by a `LITE_HARNESS_*` environment
variable name in server configuration; credentials are not embedded in JSON.
