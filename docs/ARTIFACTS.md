# Artifacts

The `artifact_publish` agent tool accepts only a relative path in the current
owned workspace plus a media type. It does not accept inline text or base64.
Manager reads the file through the active workspace runtime with a hard byte
limit, then publishes exactly those bytes. Registered host paths and managed
Docker volumes therefore use the same owner, path, and size checks.

Artifact blobs use AES-256-GCM with a per-artifact HKDF key derived from the
installation snapshot root key. Metadata is owner-scoped in SQLite. Publication
writes and syncs a staging ciphertext, inserts metadata in an immediate
transaction, atomically promotes the blob, and commits visibility. Downloads
authenticate the envelope and metadata before returning plaintext.

Production uses `LITE_HARNESS_SNAPSHOT_KEY` or the OS-held `snapshot.root`.
Development creates a permission-restricted, local-only key under the data
directory so artifacts survive a Manager restart. This fallback is not used in
production and must never be committed.

Browser captures and explicit app uploads use separate trusted Manager routes;
they do not expand the agent tool's authority.
