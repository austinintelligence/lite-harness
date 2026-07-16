export interface EvidenceArtifact { name: string; sha256: string }
export interface EvidenceCounts { total: number; passed: number; failed: number; skipped: number; todo: number }
export interface EvidenceCase { path: string; name: string; status: "passed" | "failed" | "skipped" | "todo" | "blocked" }
export interface EvidenceFacts {
  commit: string;
  tree: string;
  dirty: boolean;
  at: string;
  platform: { os: string; release: string; architecture: string; cpu: string; logicalCpus: number };
  runtime: {
    node: string;
    pnpm: string;
    docker: Record<string, unknown>;
  };
  ci: { provider: string | null; workflow: string | null; job: string | null; runId: string | null; runAttempt: string | null };
}
export interface EvidenceDocument {
  schemaVersion: 2;
  kind: "test-suite" | "policy-check" | "measurement" | "aggregate";
  evidenceId: string;
  subject: { source: { commit: string; tree: string; dirty: boolean }; scope: string; packages: EvidenceArtifact[]; images: EvidenceArtifact[] };
  capture: Record<string, unknown>;
  test: { suite: string; command: string; result: "pass" | "fail" | "blocked"; counts: EvidenceCounts; durationMs: number; cases: EvidenceCase[] };
  coverage: { requirementIds: string[]; regressionIds: string[] };
  claims: Record<string, unknown>;
  attachments: Array<{ name: string; mediaType: string; sha256: string; content: unknown }>;
  externalGates: Record<string, string>;
}
export const missingExternalGates: Readonly<Record<string, "missing">>;
export const requiredExternalGateNames: readonly string[];
export function sanitizeDiagnosticText(value: unknown, options?: { maxBytes?: number }): string;
export function writeVitestEvidence(options: Record<string, unknown>): EvidenceDocument;
export function writePolicyEvidence(options: Record<string, unknown>): EvidenceDocument;
export function createEvidenceDocument(options: Record<string, unknown>): EvidenceDocument;
export function validateEvidenceDocument(document: unknown, options?: { expectedCommit?: string; expectedTree?: string; requireClean?: boolean }): string[];
export function writeEvidenceFile(path: string, document: EvidenceDocument): void;
export function captureFacts(root: string): EvidenceFacts;
export function embeddedAttachment(name: string, mediaType: string, content: unknown): { name: string; mediaType: string; sha256: string; content: unknown };
