import { describe, expect, it } from "vitest";
import { getCampaign, isKnownCampaign } from "../campaigns.js";

describe("campaign registry", () => {
  it("knows both active scan campaigns and rejects everything else", () => {
    expect(isKnownCampaign("production-scan")).toBe(true);
    expect(isKnownCampaign("agent-readiness")).toBe(true);
    expect(isKnownCampaign("nope")).toBe(false);
    expect(isKnownCampaign(null)).toBe(false);
    expect(isKnownCampaign("")).toBe(false);
  });

  it("getCampaign returns the web handoff config for a known slug, null otherwise", () => {
    expect(getCampaign("production-scan")).toMatchObject({
      slug: "production-scan",
      needsRepo: true,
      action: { queryValue: "fix", topic: "Fix production scan blockers" },
    });
    expect(getCampaign("agent-readiness")).toMatchObject({
      slug: "agent-readiness",
      needsRepo: true,
      action: { queryValue: "fix", topic: "Adopt agent readiness fixes" },
    });
    expect(getCampaign("unknown")).toBeNull();
    expect(getCampaign(null)).toBeNull();
  });
});
