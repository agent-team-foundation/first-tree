import { describe, expect, it } from "vitest";
import { getCampaignScanSkill } from "../services/campaign-scan-skill.js";

describe("campaign scan skills", () => {
  it("resolves production scan by slug and is null otherwise", () => {
    expect(getCampaignScanSkill("production-scan")?.name).toBe("production-scan");
    expect(getCampaignScanSkill("agent-readiness")).toBeNull();
    expect(getCampaignScanSkill("nope")).toBeNull();
  });

  it("produces a scored verdict report, chat-only, no side effects", () => {
    const body = (getCampaignScanSkill("production-scan")?.body ?? "").replace(/\s+/g, " ");
    // New scored-verdict contract (replaced the old ps-1 JSON schema).
    expect(body).toContain("score 8 dimensions");
    expect(body).toContain("Ready to launch");
    expect(body).toContain("Step 0 — get the repo");
    // v1 is chat-only: never auto-files issues or auto-posts a hosted report.
    expect(body).toContain("do NOT file issues, POST anything, or write to the repo");
    // Voice boundary: anything written into the user's repo stays professional.
    expect(body).toContain("zero roast");
  });

  it("drives the conversion payoff: produce a real fix + offer to apply, but read-only until consent", () => {
    // Normalize whitespace so phrase checks don't depend on body line-wrapping.
    const body = (getCampaignScanSkill("production-scan")?.body ?? "").replace(/\s+/g, " ");
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
    // Growth flow does NOT auto-follow the PR — on a fresh org that surfaces an
    // "install the GitHub App" admin error; the skill forbids it and forbids
    // surfacing any such failure to the user.
    expect(body).toContain("github follow");
    expect(body).toContain("install the GitHub App");
    // Never leak internal workspace mechanics (clones/worktrees/collisions) to the user.
    expect(body).toContain("never expose your internal working mechanics");
  });

  it("keeps momentum after the fix: quality bar, tasteful attribution, one next step", () => {
    const body = (getCampaignScanSkill("production-scan")?.body ?? "").replace(/\s+/g, " ");
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
    // (1) gated on the apply offer resolving first.
    expect(body).toContain("apply offer");
    // (2) Step 6 is a PLAIN MESSAGE carrying the env-templated setup link — NOT an
    //     ask-user card (it hands off to a web onboarding flow). The server replaces
    //     the placeholder with the env-correct URL at skill materialization.
    expect(body).toContain("{{FIRST_TREE_SETUP_URL}}");
    expect(body).toContain("NOT an ask-user card");
    // (3) the CTA drives First Tree setup (connect own computer + create own agent).
    expect(body).toContain("Set up First Tree for your team");
    // (4) explicit stop condition — one invitation, no re-pitch, never a menu.
    expect(body).toContain("don't re-pitch");
    expect(body).toContain("never a menu");
    // (5) the Step 5 apply-consent offer is still a tracked ask-user card.
    expect(body).toContain("tracked ask-user");
  });
});
