# ADR 0045: Playwright and Chromium browser container

- Status: accepted
- Date: 2026-07-14
- Covers: Research 13

## Primary sources

- Playwright Docker: https://playwright.dev/docs/docker (Playwright 1.61.1; retrieved 2026-07-14)
- Playwright browser installation: https://playwright.dev/docs/browsers (current Playwright; retrieved 2026-07-14)
- Playwright BrowserType API: https://playwright.dev/docs/api/class-browsertype (current Playwright; retrieved 2026-07-14)

## Decision

Pin the Playwright package and Microsoft image to the same patch version and digest. Run the browser server as non-root pwuser with init and the documented sandbox-compatible seccomp profile; never add SYS_ADMIN in production. Use an isolated profile, bounded downloads/artifacts, explicit CDP policy, and brokered egress. Do not claim the container alone is safe for hostile websites.

## Alternatives considered

Rejected: Version-mismatched package/image pairs; root with Chromium sandbox disabled; host-browser reuse as the default managed mode.

## Security impact

Non-root Chromium sandboxing, seccomp, network policy, profile isolation, and artifact bounds reduce browser-to-host and cross-run exposure.

## Compatibility impact

Browser protocol compatibility follows the exact Playwright version. Remote CDP and branded browsers are preview unless separately proven.

## Migration plan

Upgrade both package and image to 1.61.1, add the seccomp profile/init, prove sandbox state and download/profile cleanup, then remove the mismatched image.

## Release impact

The current 1.61.0 image is behind current 1.61.1 guidance and blocks the browser boundary until migrated and tested.
