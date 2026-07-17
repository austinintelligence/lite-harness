declare module "*.mjs" {
  export function validateWorkflowStructure(text: string, filename: string): string[];
  export function extractRequirements(planPath?: string): Array<{
    id: string;
    tier: string;
    required: boolean;
  }>;
}
