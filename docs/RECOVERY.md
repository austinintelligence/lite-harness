# Recovery and export

## Normal restart

Gateway is stateless and may restart during a run. Reconnect SSE with the last
sequence. Manager restart reconciles nonterminal attempts to `ORPHANED`; submit
a deliberate retry with a new idempotency key.

## Workspace snapshots

1. Set `LITE_HARNESS_RUNTIME_IMAGE` to an immutable image digest or ID.
2. Set `LITE_HARNESS_SNAPSHOT_KEY` to a base64-encoded 32-byte key stored
   outside the repository and data directory.
3. Run `pnpm lite workspace snapshot <workspace-id>`.
4. Copy `.lite-harness/snapshots` and the key to separate protected storage.

Restore with `pnpm lite workspace restore <workspace-id>`. Ciphertext is
authenticated and hashed before Docker import. If the current generation is
corrupt, Lite-Harness attempts the previous generation. Docker restore stages
and backs up volumes before replacing live contents.

Never delete a named volume until a snapshot restore has been verified. Use
`pnpm lite workspace delete <workspace-id>` only as an explicit cleanup step.

## Database and artifacts

Stop Manager before copying `lite-harness.db`, `-wal`, and `-shm` files. Copy
the entire artifact directory so metadata sidecars remain paired with bytes.
Run `pnpm lite doctor` after restoring to verify Docker and the data directory.
