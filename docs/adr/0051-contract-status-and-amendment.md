# ADR 0051: Architecture contract status and amendment process

- Status: accepted
- Date: 2026-07-14
- Covers: Plan contradiction: freeze candidate versus final implementation

## Primary sources

- Architecture contract: ../../LITE_HARNESS_ARCHITECTURE_PLAN.md (SHA-256 cfdddc9214ff0192d48bf899b70947f35937945e7c1403b5b59a85f454f2408f; retrieved 2026-07-14)
- Alpha requirement ledger: ../requirements/alpha-ledger.yaml (schema version 1; retrieved 2026-07-14)

## Decision

Treat the reviewed plan hash as the immutable architecture contract baseline, not proof that implementation is final. ADRs may clarify contradictions or supersede a decision; they never rewrite historical evidence. Every amendment names affected requirement IDs, migration, tests, and release impact. Generated status comes only from current ledger/evidence.

## Alternatives considered

Rejected: Editing the plan until it matches implementation; treating the plan as aspirational and non-binding; declaring completion from file existence.

## Security impact

Immutable baseline plus explicit amendments prevents silent erosion of trust boundaries and release gates.

## Compatibility impact

Contributors can distinguish baseline intent, accepted amendments, implementation status, and external blockers.

## Migration plan

Link each requirement to ADR/code/test/CI/evidence, add an amendment index, and reject status changes lacking current production-path proof.

## Release impact

The generated verdict may report a VERIFIED LOCAL ALPHA CANDIDATE when all locally actionable rows and defects have current evidence; unavailable platform, provider, naming, signing, and registry authorities remain explicitly blocked-external until their own evidence exists.
