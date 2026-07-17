export interface RunningDockerContainer {
  id: string;
  name: string;
  image: string;
  labels?: string;
}

/**
 * Buildx keeps a long-lived BuildKit service container alive after an image
 * build. It is Docker infrastructure, not a Lite workload. Only that narrow,
 * independently identifiable shape is exempted; every other running
 * container remains a restart blocker.
 */
export function dockerRestartBlockers(containers: readonly RunningDockerContainer[]): RunningDockerContainer[] {
  return containers.filter((container) => !isBuildKitInfrastructureContainer(container));
}

function isBuildKitInfrastructureContainer(container: RunningDockerContainer): boolean {
  return /^buildx_buildkit_[A-Za-z0-9_.-]+$/u.test(container.name) &&
    /^moby\/buildkit(?::|$)/u.test(container.image) &&
    (!container.labels || container.labels.includes("desktop.docker.io/ports.scheme=v2") || container.labels.includes("com.docker.buildx"));
}
