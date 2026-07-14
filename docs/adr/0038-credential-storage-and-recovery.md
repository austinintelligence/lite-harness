# ADR 0038: Credential storage, recovery, and rotation

- Status: accepted
- Date: 2026-07-14
- Covers: Research 6

## Primary sources

- Secret Service API: https://specifications.freedesktop.org/secret-service/latest-single/ (freedesktop.org specification; retrieved 2026-07-14)
- Apple Keychain Services: https://developer.apple.com/documentation/security/keychain-services (current Security framework; retrieved 2026-07-14)
- Windows credential management: https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-management (current Win32 API; retrieved 2026-07-14)
- Windows Data Protection API: https://learn.microsoft.com/en-us/windows/win32/secauthn/data-protection (DPAPI; retrieved 2026-07-14)

## Decision

Store small credential records in Secret Service on desktop Linux, Keychain SecItem APIs on macOS, and user-scoped DPAPI-protected records on Windows. Headless Linux without an unlocked Secret Service collection must require an explicit operator-supplied recovery key/passphrase; it must not fall back to plaintext. Keep provider keys, snapshot wrapping keys, and integration secrets in separate namespaces with versioned key IDs and online rotation.

## Alternatives considered

Rejected: Plaintext dotfiles; environment variables as durable storage; one shared master secret without versioning.

## Security impact

Uses OS access controls while making headless failure explicit. Separation and key IDs support least privilege, revocation, and staged re-encryption.

## Compatibility impact

Credential portability is by export/import of an encrypted recovery envelope, not copying OS store files.

## Migration plan

Implement native adapters, migrate existing encrypted records, generate recovery material once with confirmation, support old/new key overlap, then destroy retired key material after verification.

## Release impact

Requires locked/unlocked, missing-store, rotation, recovery, and redaction tests on each supported OS.
