# Cache lifecycle

Lite-Harness treats caches as disposable, explicitly scoped derived data. User
source, generated deliverables, chat history, and workspace snapshots are not
caches. Docker owns image layers and BuildKit owns image-build caching.

`LocalCacheCatalog` manages immutable derived-cache generations with a durable
SQLite catalog. A cache key freezes the cache class and kind, owner scope,
source and lock digests, tool and framework versions, runtime version, pinned
base-image digest, operating system, CPU architecture, selected non-secret
configuration digest, and cache-policy version. Private keys include their
tenant and, for workspace-private entries, workspace identity.

Population uses a time-bounded lease and monotonic fencing token. Writers may
only create regular files under a private staging directory. Promotion rejects
links and special files, enforces file and byte limits, records a deterministic
input manifest, atomically renames the generation, and marks its tree read-only.
Only a trusted publisher may create a global generation. Sandboxes have no
direct global publication surface.

Every attach revalidates the manifest and creates a bounded read lease. The
returned mount descriptor is explicitly read-only; a runtime integration must
preserve that flag when creating a container mount. A missing, structurally
invalid, or modified generation is moved out of the entry tree and marked
quarantined before attach can continue.

Garbage collection expires abandoned staging and read leases, removes
quarantined data, then applies size-aware least-recently-used eviction. Entries
with active readers are never evicted. Cache data is never part of workspace or
artifact recovery guarantees and may always be rebuilt from its frozen inputs.

Set `LITE_HARNESS_ENABLE_CACHE_CATALOG=true` to compose the catalog and its
owner-scoped `cache_resolve` capability into Manager. The public tool returns
only key, class, and lifecycle state; it never reveals host paths. Publication,
attachment paths, release, verification, and garbage collection remain
Manager-owned operations rather than model-controlled filesystem APIs.
