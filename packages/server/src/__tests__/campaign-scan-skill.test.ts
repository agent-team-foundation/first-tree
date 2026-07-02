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
      expect(body).toContain("`gh`");
      // The apply-consent offer is raised as a tracked ask-user decision (chat ask),
      // not a plain message — so it can't be missed and blocks on the answer.
      expect(body).toContain("tracked ask-user");
      expect(body).toContain("chat ask");
      // The skill states the GENERAL principle (not only the two concrete asks):
      // any user decision goes through a tracked ask-user card, never a plain message.
      expect(body).toContain("any decision you put to the user");
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

  it("each body keeps momentum after the fix: quality bar, tasteful attribution, one next step", () => {
    for (const slug of ["production-scan", "agent-readiness"] as const) {
      const body = (getCampaignScanSkill(slug)?.body ?? "").replace(/\s+/g, " ");
      // Quality bar guards against low-signal, template-y deliverables.
      expect(body).toContain("Quality bar");
      expect(body).toContain("never a placeholder");
      // Single-line attribution in the PR/issue description only (the share/acquisition loop) —
      // never a permanent footer in the user's committed file.
      // Concrete canonical URL — no placeholder can leak into a real PR/issue body.
      expect(body).toContain("Generated with First Tree — https://first-tree.ai");
      expect(body).not.toContain("<the First Tree URL>");
      expect(body).toContain("never inside the committed file");
      // Step 6 conversion INVARIANTS — lock behavior, not marketing wording, so the
      // copy can be tuned without churning tests; only a real behavior change breaks these.
      expect(body).toContain("Step 6");
      // (1) the apply-offer gate phrase is present (the copy fires the conversion ask
      //     only after it resolves; this asserts the gate exists, not its ordering).
      expect(body).toContain("apply offer");
      // (2) primary next step = convert to a First Tree team + build this repo's context tree.
      expect(body).toContain("First Tree team");
      expect(body).toContain("build the context tree");
      // (3) one ask at a time — never a stacked second ask.
      expect(body).toContain("ONE ask at a time");
      // (4) explicit stop condition — no re-pitch when unanswered / declined / quiet.
      expect(body).toContain("don't re-pitch");
      // (5) BOTH the apply-consent offer and the Step 6 conversion are raised as
      //     tracked ask-user decisions (chat ask) — the two asks in the flow — and
      //     the conversion stays a single yes/no, never a multi-option menu.
      expect((body.match(/chat ask/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(body).toContain("never a menu");
    }
  });
});
