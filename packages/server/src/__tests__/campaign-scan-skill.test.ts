import { describe, expect, it } from "vitest";
import { getCampaignScanSkill } from "../services/campaign-scan-skill.js";

describe("campaign scan skills", () => {
  it("resolves the two campaigns by slug and is null otherwise", () => {
    expect(getCampaignScanSkill("production-scan")?.name).toBe("production-scan");
    expect(getCampaignScanSkill("agent-readiness")?.name).toBe("agent-readiness");
    expect(getCampaignScanSkill("nope")).toBeNull();
  });

  it("each body keeps its scan schema and the repo-locating step", () => {
    expect(getCampaignScanSkill("production-scan")?.body).toContain("ps-1");
    expect(getCampaignScanSkill("agent-readiness")?.body).toContain("ar-1");
    for (const slug of ["production-scan", "agent-readiness"] as const) {
      expect(getCampaignScanSkill(slug)?.body).toContain("Step 0 — get the repo");
    }
  });

  it("each body drives the conversion payoff: produce a real fix + offer to apply, but read-only until consent", () => {
    for (const slug of ["production-scan", "agent-readiness"] as const) {
      // Normalize whitespace so phrase checks don't depend on body line-wrapping.
      const body = (getCampaignScanSkill(slug)?.body ?? "").replace(/\s+/g, " ");
      // Produces a concrete deliverable, not just advice.
      expect(body).toContain("Step 5");
      expect(body).toContain("ready-to-apply");
      // Offers to apply via the user's own GitHub (gh), on a branch.
      expect(body).toContain("open a PR");
      expect(body).toContain("`gh`");
      // Consent gate: never mutates the repo without an explicit yes.
      expect(body.toLowerCase()).toContain("read-only until");
      expect(body).toContain("explicit go-ahead");
      // Even after consent the gh write is fenced to PR/issue creation only.
      expect(body).toContain("gh pr create");
      expect(body).toContain("no other mutating");
    }
    // The agent-readiness hero deliverable is a tailored AGENTS.md.
    expect(getCampaignScanSkill("agent-readiness")?.body).toContain("AGENTS.md");
  });
});
