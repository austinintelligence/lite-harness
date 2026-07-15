export interface RequirementTraceRow {
  id: string;
  required?: boolean;
  status?: string;
  implementationPaths?: unknown;
  testIds?: unknown;
  ciJob?: unknown;
  evidenceArtifacts?: unknown;
  blockers?: unknown;
}

export interface DefectTraceRow {
  id: string;
  status?: string;
  blockers?: unknown;
  regression?: {
    testId?: string;
    path?: string | null;
    result?: string;
    evidenceArtifact?: { path?: string } | null;
  };
}

export function currentCommit(root: string): string;
export function currentTree(root: string, revision?: string): string;
export function requirementVerificationFailures(
  row: RequirementTraceRow,
  options: { root: string; head: string; tree?: string },
): string[];
export function defectClosureFailures(
  defect: DefectTraceRow,
  options: { root: string; head: string; tree?: string; checkFreshness?: boolean },
): string[];
export function evaluateReleaseTruth(
  ledgers: { requirements: RequirementTraceRow[]; defects: DefectTraceRow[] },
  options: { root: string; head: string; tree?: string },
): {
  requirementEvaluations: Array<{ row: RequirementTraceRow; failures: string[]; verified: boolean }>;
  defectEvaluations: Array<{ defect: DefectTraceRow; failures: string[]; closed: boolean }>;
};
