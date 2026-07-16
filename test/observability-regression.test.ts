import { describe, expect, it } from "vitest";
import { loadManagerConfiguration } from "@lite-harness/config";
import { StructuredObservability } from "@lite-harness/observability";
import { RedactedStreamBuffer } from "@lite-harness/operations";

describe("aggregate observability qualification", () => {
  it("BD-062-REGRESSION rejects unsafe config, records bounded telemetry, and redacts split service output", () => {
    const tokens = {
      LITE_HARNESS_INTERNAL_TOKEN: "internal-token-for-tests",
      LITE_HARNESS_APP_TOKEN: "application-token-for-tests",
      LITE_HARNESS_PROVIDER: "fake",
      LITE_HARNESS_RUNTIME: "fake",
      LITE_HARNESS_MODE: "development",
    };
    expect(() => loadManagerConfiguration({
      ...tokens,
      LITE_HARNESS_APPROVAL_TIMEOUT_MS: "NaN",
    }, "C:/fixture", "win32")).toThrow(/APPROVAL_TIMEOUT_MS.*integer/);
    expect(() => loadManagerConfiguration({
      ...tokens,
      LITE_HARNESS_ENABLE_PLUGINS: "tru",
    }, "C:/fixture", "win32")).toThrow(/exactly true or false/);

    let now = 1_000;
    const observability = new StructuredObservability({ now: () => now, maxEvents: 8 });
    const trace = observability.startTrace("run.execute", {
      authorization: "Bearer aggregate-secret",
      prompt: "private prompt",
    });
    now += 5;
    trace.end({ outcome: "completed" });
    observability.counter("run.completed", 1, { traceId: trace.traceId });
    observability.audit("run.completed", "completed", { credential: "private-credential" }, trace);
    const snapshot = observability.snapshot();
    expect(snapshot.counters).toMatchObject({
      "trace.run.execute.completed": 1,
      "run.completed": 1,
    });
    expect(snapshot.histograms["trace.run.execute.duration_ms"]).toMatchObject({ count: 1, sum: 5, max: 5 });
    expect(snapshot.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["trace", "metric", "audit"]));
    expect(JSON.stringify(snapshot)).not.toContain("aggregate-secret");
    expect(JSON.stringify(snapshot)).not.toContain("private prompt");
    expect(JSON.stringify(snapshot)).not.toContain("private-credential");

    const output: string[] = [];
    const stream = new RedactedStreamBuffer((chunk) => output.push(chunk));
    stream.write("Authorization: Bearer ");
    stream.write("split-service-secret\n");
    stream.write('{"cookie":"private-cookie"}\n');
    stream.end();
    expect(output.join("")).toContain("[REDACTED]");
    expect(output.join("")).not.toContain("split-service-secret");
    expect(output.join("")).not.toContain("private-cookie");
  });
});
