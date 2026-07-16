import { describe, expect, it } from "vitest";
import {
  ManagedBrowserBroker,
  type BrowserActionResult,
  type BrowserDriver,
  type BrowserNetworkPolicy,
} from "@lite-harness/browser";

describe("managed browser scale-to-zero lifecycle", () => {
  it("A22-ENABLED-IDLE-ZERO single-flights startup, protects overlapping actions, and reaps after final idle", async () => {
    let releaseStart!: () => void;
    let releaseSlow!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let executeCount = 0;
    const driver: BrowserDriver & { starts: number; stops: number } = {
      starts: 0,
      stops: 0,
      async start(_policy: BrowserNetworkPolicy) { this.starts += 1; await startGate; },
      async execute(): Promise<BrowserActionResult> {
        executeCount += 1;
        const current = executeCount;
        if (current === 1) await slowGate;
        return { title: `fixture-${current}` };
      },
      async stop() { this.stops += 1; },
    };
    const broker = new ManagedBrowserBroker(() => driver, { idleTtlMs: 20 });
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run-scale-zero" };
    const session = broker.create(owner);
    const slowCall = broker.execute(session, owner, { action: "snapshot" });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    const fastCall = broker.execute(session, owner, { action: "snapshot" });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(driver.starts).toBe(1);

    releaseStart();
    await expect(fastCall).resolves.toEqual({ title: "fixture-2" });
    await new Promise((resolveDone) => setTimeout(resolveDone, 35));
    expect(broker.activeCount).toBe(1);
    expect(driver.stops).toBe(0);

    releaseSlow();
    await expect(slowCall).resolves.toEqual({ title: "fixture-1" });
    await new Promise((resolveDone) => setTimeout(resolveDone, 35));
    expect(broker.activeCount).toBe(0);
    expect(driver.stops).toBe(1);
  });

  it("A22-BROWSER-CLOSE-DRAIN waits for accepted startup and action before stopping the driver", async () => {
    const startGate = deferred();
    const executeGate = deferred();
    const executeStarted = deferred();
    let stopped = false;
    let closeSettled = false;
    const driver: BrowserDriver = {
      async start() { await startGate.promise; },
      async execute() {
        if (stopped) throw new Error("browser executed after stop");
        executeStarted.resolve();
        await executeGate.promise;
        if (stopped) throw new Error("browser stopped during action");
        return { title: "action-drained" };
      },
      async stop() { stopped = true; },
    };
    const broker = new ManagedBrowserBroker(() => driver, { idleTtlMs: 1_000 });
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run-close" };
    const session = broker.create(owner);
    const action = broker.execute(session, owner, { action: "snapshot" });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    const closing = broker.close(session, owner).then(() => { closeSettled = true; });
    startGate.resolve();
    await executeStarted.promise;
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect({ stopped, closeSettled, activeCount: broker.activeCount }).toEqual({ stopped: false, closeSettled: false, activeCount: 1 });
    executeGate.resolve();
    await expect(action).resolves.toEqual({ title: "action-drained" });
    await closing;
    expect({ stopped, closeSettled, activeCount: broker.activeCount }).toEqual({ stopped: true, closeSettled: true, activeCount: 0 });
  });

  it("A22-BROWSER-UPLOAD-CLOSE-DRAIN waits for an accepted upload before cleanup", async () => {
    const uploadGate = deferred();
    const uploadStarted = deferred();
    let stops = 0;
    const driver: BrowserDriver = {
      async start() { /* local fake */ },
      async execute() { return {}; },
      async prepareUpload(_name, materialize) {
        await materialize("fixture-path");
        uploadStarted.resolve();
        await uploadGate.promise;
        return "q_fixture";
      },
      async stop() { stops += 1; },
    };
    const broker = new ManagedBrowserBroker(() => driver, { idleTtlMs: 1_000 });
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run-upload" };
    const session = broker.create(owner);
    const upload = broker.prepareUpload(session, owner, "fixture.txt", async () => undefined);
    await uploadStarted.promise;
    let closeSettled = false;
    const closing = broker.close(session, owner).then(() => { closeSettled = true; });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect({ stops, closeSettled }).toEqual({ stops: 0, closeSettled: false });
    uploadGate.resolve();
    await expect(upload).resolves.toBe("q_fixture");
    await closing;
    expect({ stops, closeSettled, activeCount: broker.activeCount }).toEqual({ stops: 1, closeSettled: true, activeCount: 0 });
  });

  it("A22-BROWSER-CLOSE-ALL-DRAIN drains active sessions while stopping idle siblings", async () => {
    const actionGate = deferred();
    const actionStarted = deferred();
    const drivers: Array<BrowserDriver & { stops: number }> = [];
    const broker = new ManagedBrowserBroker(() => {
      const ordinal = drivers.length;
      const driver: BrowserDriver & { stops: number } = {
        stops: 0,
        async start() { /* local fake */ },
        async execute() {
          actionStarted.resolve();
          await actionGate.promise;
          return { title: `driver-${ordinal}` };
        },
        async stop() { this.stops += 1; },
      };
      drivers.push(driver);
      return driver;
    }, { idleTtlMs: 1_000 });
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run-close-all" };
    const activeSession = broker.create(owner);
    broker.create({ ...owner, runId: "run-idle-sibling" });
    const action = broker.execute(activeSession, owner, { action: "snapshot" });
    await actionStarted.promise;
    let closeSettled = false;
    const closing = broker.closeAll().then(() => { closeSettled = true; });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(() => broker.create({ ...owner, runId: "run-too-late" })).toThrow(/closing all sessions/);
    expect({ activeStops: drivers[0]?.stops, idleStops: drivers[1]?.stops, closeSettled }).toEqual({ activeStops: 0, idleStops: 1, closeSettled: false });
    actionGate.resolve();
    await expect(action).resolves.toEqual({ title: "driver-0" });
    await closing;
    expect({ stops: drivers.map((driver) => driver.stops), activeCount: broker.activeCount }).toEqual({ stops: [1, 1], activeCount: 0 });
  });

  it("A22-BROWSER-CLOSE-ALL-FAILURE reports persistence failures after cleaning every session", async () => {
    const stops: number[] = [];
    const broker = new ManagedBrowserBroker(() => {
      const ordinal = stops.length;
      stops.push(0);
      return {
        async start() { /* local fake */ },
        async execute() { return { title: `driver-${ordinal}` }; },
        async restoreProfile() { /* local fake */ },
        async exportProfile() { return "fixture-profile"; },
        async stop() { stops[ordinal] = (stops[ordinal] ?? 0) + 1; },
      };
    }, {
      idleTtlMs: 1_000,
      profileStore: {
        async load() { return undefined; },
        async save(profileId) {
          if (profileId === "broken-profile") throw new Error("fixture profile save failed");
        },
      },
    });
    const owner = { appId: "app", tenantId: "tenant", userId: "user", runId: "run-close-failure" };
    const broken = broker.create(owner, {}, "broken-profile");
    const healthy = broker.create({ ...owner, runId: "run-close-healthy" }, {}, "healthy-profile");
    await broker.execute(broken, owner, { action: "snapshot" });
    await broker.execute(healthy, { ...owner, runId: "run-close-healthy" }, { action: "snapshot" });

    await expect(broker.closeAll()).rejects.toThrow("One or more browser sessions failed to close");
    expect({ stops, activeCount: broker.activeCount }).toEqual({ stops: [1, 1], activeCount: 0 });
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
