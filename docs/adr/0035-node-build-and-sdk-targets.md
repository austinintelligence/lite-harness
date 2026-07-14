# ADR 0035: Node, TypeScript, and SDK build targets

- Status: accepted
- Date: 2026-07-14
- Covers: Research 3

## Primary sources

- Node release schedule: https://nodejs.org/en/about/previous-releases (Node 24 LTS; retrieved 2026-07-14)
- TypeScript module compiler guidance: https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html (TypeScript 5.9; retrieved 2026-07-14)

## Decision

Node 24 LTS and TypeScript 5.9 are the alpha toolchain. Applications and the TypeScript SDK must ship compiled ESM with declarations and source maps. The alpha SDK is Node-only; browser support requires a later fetch-only package with no Node built-ins. Production entry points must not require tsx, workspace links, or source files.

## Alternatives considered

Rejected: Running TypeScript source in production; dual CJS/ESM output without consumer evidence; claiming browser support from type compatibility alone.

## Security impact

Compiled, exported entry points reduce runtime loader ambiguity and keep private source paths out of the supported surface.

## Compatibility impact

Consumers get an explicit Node engine range and ESM contract. CommonJS and browsers are not alpha-supported.

## Migration plan

Add per-package build outputs and export maps, pack/install fixtures, declaration checks, and Node 24 external-consumer tests before any package is publishable.

## Release impact

Blocks M1 until compiled apps, packed SDK, wheel/sdist, and clean external installs run without workspace dependencies.
