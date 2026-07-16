export interface ExternalPlatformGate {
  os: string;
  architecture: string;
  rootless: boolean;
  desktop: boolean;
  runnerLabels: readonly string[];
}

export const externalPlatformGates: Readonly<Record<string, ExternalPlatformGate>>;
export const externalPlatformGateNames: readonly string[];
export const externalPlatformEvidencePaths: Readonly<Record<string, string>>;
export function validateExternalPlatform(gate: string, facts: unknown, dockerInfo: unknown): string[];
