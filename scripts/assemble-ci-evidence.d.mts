export const candidateEvidenceLayout: ReadonlyArray<readonly [source: string, target: string]>;
export interface CandidateEvidenceCatalogEntry {
  source: string;
  target: string;
  ciJob: string;
  producer: string;
  kind: "test-suite" | "policy-check";
  suite: string;
}
export interface ExternalGateAuthority {
  path: string;
  ciJob: string;
  os: string | null;
  architecture: string | null;
  kind: "policy-check";
  scope: "external-platform";
  suite: string;
  producer: string;
}
export const candidateEvidenceCatalog: ReadonlyArray<Readonly<CandidateEvidenceCatalogEntry>>;
export const requiredExternalGateAuthorities: Readonly<Record<string, Readonly<ExternalGateAuthority>>>;
export function candidateEvidenceProducer(path: string): Readonly<CandidateEvidenceCatalogEntry> | null;
export function candidateEvidenceCatalogFailures(
  path: string,
  document: Record<string, any>,
  options?: { catalog?: ReadonlyArray<Readonly<CandidateEvidenceCatalogEntry>>; expectedCi?: Record<string, string | null | undefined> },
): string[];
export function assembleCandidateEvidence(sourceRoot: string, targetRoot: string, options?: { allowIncomplete?: boolean }): string[];
