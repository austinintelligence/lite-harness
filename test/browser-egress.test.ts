import { describe, expect, it } from "vitest";
import {
  DockerBrowserDriver,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserDriver,
  type BrowserNetworkPolicy,
  type BrowserProcessFactory,
} from "@lite-harness/browser";

describe("external browser egress boundary", () => {
  it("keeps Chromium internal and connects only the policy proxy externally", async () => {
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
    expect(proxyRun).toEqual(expect.arrayContaining(["--network", internalNetwork, "--cap-drop", "ALL", "--read-only"]));
    expect(externalConnects).toHaveLength(1);
    expect(externalConnects[0]).toEqual(["network", "connect", "bridge", expect.stringMatching(/^lite-browser-egress-/)]);
    expect(processSpec?.args).toEqual(expect.arrayContaining(["--network", internalNetwork, "--cap-drop", "ALL"]));
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
});

class FakeProcessDriver implements BrowserDriver {
  starts: BrowserNetworkPolicy[] = [];
  stops = 0;
  async start(policy: BrowserNetworkPolicy): Promise<void> { this.starts.push(policy); }
  async execute(_command: BrowserAction): Promise<BrowserActionResult> { return {}; }
  async stop(): Promise<void> { this.stops += 1; }
}
