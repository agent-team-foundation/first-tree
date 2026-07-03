import { describe, expect, it } from "vitest";
import { getCampaign, isKnownCampaign } from "../campaigns.js";

describe("campaign registry", () => {
  it("knows the production scan campaign and rejects everything else", () => {
    expect(isKnownCampaign("production-scan")).toBe(true);
    expect(isKnownCampaign("agent-readiness")).toBe(false);
    expect(isKnownCampaign("nope")).toBe(false);
    expect(isKnownCampaign(null)).toBe(false);
    expect(isKnownCampaign("")).toBe(false);
  });

  it("getCampaign returns the web handoff config for a known slug, null otherwise", () => {
    expect(getCampaign("production-scan")).toEqual({ slug: "production-scan", needsRepo: true });
    expect(getCampaign("agent-readiness")).toBeNull();
    expect(getCampaign("unknown")).toBeNull();
    expect(getCampaign(null)).toBeNull();
  });
});
