import type { EvidenceDocument, EvidenceFacts } from "./evidence-lib.mjs";
import type { CandidateEvidenceCatalogEntry, ExternalGateAuthority } from "./assemble-ci-evidence.mjs";
export function aggregateCandidateEvidence(options: {
  root: string;
  paths?: string[];
  missingPaths?: string[];
  allowInvalid?: boolean;
  output?: string;
  facts?: EvidenceFacts;
  ledgerQualification?: Record<string, unknown>;
  producerResults?: Record<string, { result?: string }>;
  fanInChecks?: Record<string, string>;
  catalog?: ReadonlyArray<Readonly<CandidateEvidenceCatalogEntry>>;
  gateAuthorities?: Readonly<Record<string, Readonly<ExternalGateAuthority>>>;
}): EvidenceDocument;
