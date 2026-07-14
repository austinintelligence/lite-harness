# Plugins, skills, and MCP

Plugins use `lite-plugin.json` with schema version, stable ID/version, relative
entry, trust class, and declared permissions. Manifest inspection reads JSON
and validates paths; it does not execute the entry. Operator grants are
intersected with declarations.

`LazyPluginSupervisor` starts a worker on first invocation, applies an
invocation timeout, clears failed workers, and stops idle workers. Production
third-party entries should use the isolated process worker protocol; trusted
in-process factories are for reviewed built-ins and tests.

SKILL.md discovery is bounded, ignores symlinks, snapshots content, and uses
deterministic precedence. Requested tool metadata is informational and cannot
grant a tool.

MCP servers are registered as lazy transports. Payloads and time are bounded;
a timeout, oversized response, or crash stops only that server. Remote MCP
origins and credentials must pass normal plugin/network policy.

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
