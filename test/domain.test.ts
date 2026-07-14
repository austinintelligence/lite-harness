import { describe, expect, it } from "vitest";
import { assertRunTransition, InvalidRunTransitionError } from "@lite-harness/domain";

describe("run state machine", () => {
  it("allows the normal lifecycle", () => {
    expect(() => assertRunTransition("ACCEPTED", "QUEUED")).not.toThrow();
    expect(() => assertRunTransition("QUEUED", "PREPARING")).not.toThrow();
    expect(() => assertRunTransition("PREPARING", "RUNNING")).not.toThrow();
    expect(() => assertRunTransition("RUNNING", "SUCCEEDED")).not.toThrow();
  });

  it("rejects resurrection of a terminal run", () => {
    expect(() => assertRunTransition("SUCCEEDED", "RUNNING")).toThrow(InvalidRunTransitionError);
  });
});
