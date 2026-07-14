# ADR 0040: Snapshot encryption, compression, and atomic publication

- Status: accepted
- Date: 2026-07-14
- Covers: Research 8

## Primary sources

- libsodium secretstream: https://doc.libsodium.org/secret-key_cryptography/secretstream (XChaCha20-Poly1305 secretstream; retrieved 2026-07-14)
- Zstandard: https://facebook.github.io/zstd/ (zstd 1.5.7 and RFC 8878; retrieved 2026-07-14)
- Node filesystem API: https://nodejs.org/download/release/latest-v24.x/docs/api/fs.html (Node 24; retrieved 2026-07-14)

## Decision

Snapshot format v1 is a versioned manifest plus a bounded zstd stream encrypted and authenticated with libsodium secretstream. Generate a per-snapshot data key, wrap it with a versioned root key, authenticate metadata as associated data, enforce chunk/window/output limits before extraction, write to a same-filesystem temporary path, fsync file data, atomically replace the target, and fsync the parent directory where supported.

## Alternatives considered

Rejected: Whole-file AES-GCM buffering; unauthenticated compression; rename without durable flush; extracting paths before validation.

## Security impact

Streaming AEAD, key hierarchy, authenticated metadata, and decompression/path limits address tampering, nonce misuse, zip bombs, and traversal.

## Compatibility impact

The archive version and algorithms are explicit and language-neutral; readers may support multiple versions during rotation.

## Migration plan

Implement v1 alongside the current envelope, round-trip and tamper fixtures, bounded-memory multi-GB tests, recovery-key rewrap, then migrate snapshots lazily on successful read.

## Release impact

Requires cross-platform power-loss/replace semantics evidence and recovery drills.
