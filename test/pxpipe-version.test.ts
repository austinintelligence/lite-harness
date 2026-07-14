import {
  PXPIPE_EVALUATED_VERSION,
  assertEvaluatedPxpipeVersion,
  installedPxpipeVersion,
} from "@lite-harness/context";
import { describe, expect, it } from "vitest";

describe("pxpipe evaluated dependency", () => {
  it("matches the installed optional dependency exactly", () => {
    expect(installedPxpipeVersion()).toBe(PXPIPE_EVALUATED_VERSION);
    expect(() => assertEvaluatedPxpipeVersion()).not.toThrow();
  });
});
