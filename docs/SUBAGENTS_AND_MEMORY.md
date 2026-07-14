# Subagents and memory

Manager registers `subagent_spawn`, `subagent_wait`, and `subagent_cancel` as
brokered tools. Child runs are durable `RunRecord` rows with a parent ID and
depth. They inherit identity and workspace ownership, receive budgets no larger
than the parent's remaining envelope, execute through normal workspace/session
queues, and cannot acquire delivery authority from a prompt. Parent
cancellation propagates through descendants.

`memory_add`, `memory_search`, and `memory_get` use tenant/workspace-scoped
SQLite FTS5. Exact Markdown remains the authoritative removable store and works
offline. Enable the pack with `LITE_HARNESS_ENABLE_MEMORY=true`; disabled mode
does not import the runtime package, create a database, or advertise memory
tools. `VectorMemoryIndex` is an optional ABI: hybrid search may add ranked
references, but disabling or rebuilding it does not remove exact memory.

Memory is user-controlled application data, not an implicit prompt dump.
Deployments should expose retention/deletion UX, avoid storing secrets, and
apply the same backup and ownership policy as sessions and workspaces.
