export interface ManagerShutdownStage {
  name: string;
  stop(): void | Promise<void>;
}

export async function shutdownManagerStages(stages: readonly ManagerShutdownStage[]): Promise<void> {
  const failures: Error[] = [];
  for (const stage of stages) {
    try { await stage.stop(); }
    catch (error) {
      failures.push(new Error(`Manager shutdown stage failed: ${stage.name}`, { cause: error }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Manager shutdown completed with cleanup failures");
}
