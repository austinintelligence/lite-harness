import { describe, expect, it } from "vitest";
import {
  DockerBrowserDriver,
  ExternalBrowserEgressBroker,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserDriver,
  type BrowserNetworkPolicy,
  type BrowserProcessFactory,
} from "@lite-harness/browser";

describe("external browser egress boundary", () => {
  it("BD-042-REGRESSION keeps Chromium internal and connects only the policy proxy externally", async () => {
    const dockerCalls: string[][] = [];
    let processSpec: { command: string; args?: readonly string[] } | undefined;
    let processOptions: { initialization: Record<string, unknown> } | undefined;
    const process = new FakeProcessDriver();
    const processFactory: BrowserProcessFactory = (spec, options) => {
      processSpec = spec;
      processOptions = options;
      return process;
    };
    const driver = new DockerBrowserDriver({
      image: `sha256:${"a".repeat(64)}`,
      dockerRunner: async (args) => {
        dockerCalls.push([...args]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
      processFactory,
    });
    const policy = { allowedOrigins: ["https://example.com"] };

    await driver.start(policy);

    const create = dockerCalls.find((args) => args[0] === "network" && args[1] === "create");
    const proxyRun = dockerCalls.find((args) => args[0] === "run");
    const externalConnects = dockerCalls.filter((args) => args[0] === "network" && args[1] === "connect");
    expect(create).toEqual(expect.arrayContaining(["--internal", "--driver", "bridge"]));
    const internalNetwork = create?.at(-1);
    expect(proxyRun).toEqual(expect.arrayContaining(["--pull=never", "--network", internalNetwork, "--cap-drop", "ALL", "--read-only"]));
    expect(proxyRun).not.toContain("seccomp=default");
    expect(externalConnects).toHaveLength(1);
    expect(externalConnects[0]).toEqual(["network", "connect", "bridge", expect.stringMatching(/^lite-browser-egress-/)]);
    expect(processSpec?.args).toEqual(expect.arrayContaining(["--pull=never", "--network", internalNetwork, "--cap-drop", "ALL"]));
    expect(processSpec?.args).not.toContain("bridge");
    expect(processOptions?.initialization.proxyServer).toMatch(/^http:\/\/lite-browser-egress-.*:8080$/);
    expect(process.starts).toEqual([policy]);

    await driver.stop();
    expect(process.stops).toBe(1);
    expect(dockerCalls).toEqual(expect.arrayContaining([
      ["container", "rm", "--force", expect.stringMatching(/^lite-browser-egress-/)],
      ["network", "rm", internalNetwork],
    ]));
  });

  it("fails closed for remote CDP because it cannot share the external broker boundary", () => {
    expect(() => new DockerBrowserDriver({
      image: `sha256:${"b".repeat(64)}`,
      remoteCdpEndpoint: "https://browser.example",
    })).toThrow(/disabled until it can use the external browser egress broker/);
  });

  it("waits for a cold egress proxy to become ready before starting Chromium", async () => {
    let readinessAttempts = 0;
    const process = new FakeProcessDriver();
    const driver = new DockerBrowserDriver({
      image: `sha256:${"c".repeat(64)}`,
      dockerRunner: async (args) => {
        if (args[0] === "exec") {
          readinessAttempts += 1;
          if (readinessAttempts < 3) return { code: 1, stdout: "", stderr: "connection refused" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      },
      processFactory: () => process,
    });

    await driver.start({ allowedOrigins: ["https://example.com"] });
    expect(readinessAttempts).toBe(3);
    expect(process.starts).toHaveLength(1);
    await driver.stop();
    expect(process.stops).toBe(1);
  });

  it("bounds a hung readiness command and still attempts authoritative Docker cleanup", async () => {
    const dockerCalls: string[][] = [];
    let probeAborted = false;
    const broker = new ExternalBrowserEgressBroker({
      image: `sha256:${"d".repeat(64)}`,
      readinessTimeoutMs: 100,
      runner: async (args, options) => {
        dockerCalls.push([...args]);
        if (args[0] !== "exec") return { code: 0, stdout: "ok", stderr: "" };
        return await new Promise((_resolve, reject) => {
          const abort = () => {
            probeAborted = true;
            reject(options?.signal?.reason ?? new Error("probe aborted"));
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });

    await expect(broker.start({ allowedOrigins: ["https://example.com"] })).rejects.toThrow(/readiness timed out after 100ms/);
    expect(probeAborted).toBe(true);
    expect(dockerCalls).toEqual(expect.arrayContaining([
      ["container", "rm", "--force", broker.containerName],
      ["network", "rm", broker.networkName],
    ]));
  });
});

class FakeProcessDriver implements BrowserDriver {
  starts: BrowserNetworkPolicy[] = [];
  stops = 0;
  async start(policy: BrowserNetworkPolicy): Promise<void> { this.starts.push(policy); }
  async execute(_command: BrowserAction): Promise<BrowserActionResult> { return {}; }
  async stop(): Promise<void> { this.stops += 1; }
}
