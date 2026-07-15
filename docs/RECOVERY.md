# Recovery and export

## Normal restart

Gateway is stateless and may restart during a run. Reconnect SSE with the last
sequence. Manager restart reconciles nonterminal attempts to `ORPHANED`; submit
a deliberate retry with a new idempotency key.

## Workspace snapshots

Managed Docker workspaces checkpoint automatically after every run that reaches
the workspace. Manager moves the workspace through `IN_USE` and `SNAPSHOTTING`,
quiesces writers while retaining the fenced lease, creates and verifies an
authenticated encrypted generation, releases the lease, and only then commits
the run's terminal state. Set
`LITE_HARNESS_WORKSPACE_COLD_AFTER_CHECKPOINT=true` to delete the warm Docker
volume after that verification and transition the workspace to `COLD`.

The next run moves a cold workspace through `RESTORING`, imports into a staging
volume, and reaches `WARM`/`IN_USE` only after authenticated restore succeeds.
An invalid current generation falls back to the previous known-good one. If no
generation verifies, state becomes `CORRUPT`; operational checkpoint failures
use `ERROR` while preserving the warm volume for retry and repair.

1. Set `LITE_HARNESS_RUNTIME_IMAGE` to an immutable image digest or ID.
2. Store the 32-byte `snapshot.root` key in the operating-system credential
   store, or set `LITE_HARNESS_SNAPSHOT_KEY` for a headless installation.
3. Copy `.lite-harness/snapshots`, the Manager database, and the recovery key to
   separate protected storage.

The `pnpm lite workspace snapshot|restore <workspace-id>` commands remain an
offline operator recovery surface, not a model tool. Ciphertext is
authenticated and hashed before Docker import. If the current generation is
corrupt, Lite-Harness attempts the previous generation. Docker restore stages
and backs up volumes before replacing live contents.

Never delete a named volume until a snapshot restore has been verified. Use
`pnpm lite workspace delete <workspace-id>` only as an explicit cleanup step.
Docker-backed writes enforce `LITE_HARNESS_WORKSPACE_QUOTA_BYTES` (1 GiB by
default) before replacement. `pnpm lite doctor` fails its disk check below 1
GiB free. A failed automatic checkpoint never deletes the warm workspace.

## Database and artifacts

Stop Manager before copying `lite-harness.db`, `-wal`, and `-shm` files. Copy
the entire artifact directory so metadata sidecars remain paired with bytes.
Run `pnpm lite doctor` after restoring to verify Docker and the data directory.
