import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRequirements } from "../scripts/requirements-lib.mjs";

describe("requirement tier integrity", () => {
  it("preserves every extracted row while separating alpha scope from future work", () => {
    const ledger = JSON.parse(readFileSync("docs/requirements/alpha-ledger.yaml", "utf8")) as {
      schemaVersion: number;
      tiers: Record<string, { releaseRequired: boolean }>;
      requirements: Array<{ id: string; tier: string; required: boolean }>;
    };
    const extracted = extractRequirements();
    expect(ledger.schemaVersion).toBe(2);
    expect(new Set(Object.keys(ledger.tiers))).toEqual(new Set(["alpha", "preview", "beta", "future"]));
    expect(ledger.requirements).toHaveLength(extracted.length);
    expect(ledger.requirements.map((row) => row.id)).toEqual(extracted.map((row) => row.id));
    for (const row of ledger.requirements) {
      expect(["alpha", "preview", "beta", "future"]).toContain(row.tier);
      expect(row.required).toBe(row.tier === "alpha");
    }
    expect(ledger.requirements.filter((row) => /^A(?:0[1-9]|1[0-9]|2[0-2])$/.test(row.id)).every((row) => row.tier === "alpha" && row.required)).toBe(true);
    expect(ledger.requirements.some((row) => row.tier === "preview")).toBe(true);
    expect(ledger.requirements.some((row) => row.tier === "beta")).toBe(true);
    expect(ledger.requirements.some((row) => row.tier === "future")).toBe(true);
  });
});
