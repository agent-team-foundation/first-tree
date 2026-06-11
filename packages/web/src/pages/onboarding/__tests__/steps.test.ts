import { describe, expect, it } from "vitest";
import {
  ADMIN_STEPS,
  clampStepIndex,
  getStepSequence,
  INVITEE_STEPS,
  inferInitialStepIndex,
  needsTreeSetup,
  resolveInviteeKickoffState,
  resolveOnboardingPath,
  resolveStepProgress,
  shouldEnterOnboarding,
  shouldLeaveOnboarding,
} from "../steps.js";

describe("resolveOnboardingPath", () => {
  it("admins take the full path", () => {
    expect(resolveOnboardingPath("admin")).toBe("admin");
  });
  it("members and unknown roles take the invitee path", () => {
    expect(resolveOnboardingPath("member")).toBe("invitee");
    expect(resolveOnboardingPath(null)).toBe("invitee");
  });
});

describe("resolveStepProgress", () => {
  it("tracks only the config steps — admin sees 3, in sequence order", () => {
    expect(resolveStepProgress("admin", "connect-computer")).toEqual({ index: 0, total: 3 });
    expect(resolveStepProgress("admin", "create-agent")).toEqual({ index: 1, total: 3 });
    expect(resolveStepProgress("admin", "connect-code")).toEqual({ index: 2, total: 3 });
  });
  it("invitee sees 2 config steps", () => {
    expect(resolveStepProgress("invitee", "connect-computer")).toEqual({ index: 0, total: 2 });
    expect(resolveStepProgress("invitee", "create-agent")).toEqual({ index: 1, total: 2 });
  });
  it("returns null on the bookends so the indicator hides there", () => {
    expect(resolveStepProgress("admin", "team")).toBeNull();
    expect(resolveStepProgress("admin", "kickoff")).toBeNull();
    expect(resolveStepProgress("invitee", "welcome")).toBeNull();
    expect(resolveStepProgress("invitee", "kickoff")).toBeNull();
  });
});

describe("getStepSequence", () => {
  it("admin sequence ends at kickoff and starts at team", () => {
    expect(getStepSequence("admin")).toEqual(ADMIN_STEPS);
    expect(ADMIN_STEPS[0]).toBe("team");
    expect(ADMIN_STEPS[ADMIN_STEPS.length - 1]).toBe("kickoff");
  });
  it("invitee skips team + code", () => {
    expect(getStepSequence("invitee")).toEqual(INVITEE_STEPS);
    expect(INVITEE_STEPS).not.toContain("team");
    expect(INVITEE_STEPS).not.toContain("connect-code");
  });
  it("connect-computer precedes create-agent in both paths (agent needs a computer)", () => {
    for (const seq of [ADMIN_STEPS, INVITEE_STEPS]) {
      expect(seq.indexOf("connect-computer")).toBeLessThan(seq.indexOf("create-agent"));
    }
  });
  it("admin: connect-code comes after create-agent (defer the GitHub ask past the first win)", () => {
    expect(ADMIN_STEPS.indexOf("connect-code")).toBeGreaterThan(ADMIN_STEPS.indexOf("create-agent"));
    expect(ADMIN_STEPS.indexOf("connect-code")).toBeLessThan(ADMIN_STEPS.indexOf("kickoff"));
  });
  it("admin: connect-code is immediately followed by kickoff", () => {
    // The build-tree recovery surface (build-tree-page.tsx) renders ONLY these
    // two steps as an adjacent pair: it pins to connect-code, and connect-code's
    // Continue (goNext) must land directly on kickoff. If a step is ever inserted
    // between them, BuildTreeBody's switch hits `default` and renders a blank
    // page — so pin this adjacency here, where the sequence invariants live.
    const seq = getStepSequence("admin");
    expect(seq[seq.indexOf("connect-code") + 1]).toBe("kickoff");
  });
});

describe("inferInitialStepIndex", () => {
  it("admin: fresh user (connect, unsettled team) starts at team", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "connect", teamSettled: false })).toBe(
      ADMIN_STEPS.indexOf("team"),
    );
  });
  it("admin: returning user past the team step lands on connect-computer", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "connect", teamSettled: true })).toBe(
      ADMIN_STEPS.indexOf("connect-computer"),
    );
  });
  it("create_agent state → the create-agent step (computer already exists)", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "create_agent", teamSettled: true })).toBe(
      ADMIN_STEPS.indexOf("create-agent"),
    );
  });
  it("completed state → admin resumes at connect-code, invitee at kickoff", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "completed", teamSettled: true })).toBe(
      ADMIN_STEPS.indexOf("connect-code"),
    );
    expect(inferInitialStepIndex("invitee", { onboardingStep: "completed", teamSettled: true })).toBe(
      INVITEE_STEPS.indexOf("kickoff"),
    );
  });
  it("invitee always starts at welcome when no computer exists", () => {
    expect(inferInitialStepIndex("invitee", { onboardingStep: "connect", teamSettled: true })).toBe(0);
    expect(inferInitialStepIndex("invitee", { onboardingStep: null, teamSettled: false })).toBe(0);
  });
});

describe("clampStepIndex", () => {
  it("clamps below 0 and above the last index", () => {
    expect(clampStepIndex("admin", -3)).toBe(0);
    expect(clampStepIndex("admin", 99)).toBe(ADMIN_STEPS.length - 1);
    expect(clampStepIndex("invitee", 2)).toBe(2);
  });
});

describe("shouldEnterOnboarding", () => {
  const base = {
    meLoaded: true,
    onboardingStep: "connect" as const,
    currentOrgReady: false,
    onboardingDismissedAt: null,
  };
  it("redirects a fresh incomplete user (no computer yet → connect)", () => {
    expect(shouldEnterOnboarding(base)).toBe(true);
  });
  it("redirects a connected user whose current org has no usable agent (create_agent)", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "create_agent", currentOrgReady: false })).toBe(true);
  });
  it("redirects an account-completed user who joined a brand-new / all-private org (org not ready)", () => {
    // The whole point of the org-level gate: a returning user who set up an
    // agent in a *prior* org must still create one here.
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "completed", currentOrgReady: false })).toBe(true);
  });
  it("does NOT redirect when connected and the current org already has a usable agent", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "completed", currentOrgReady: true })).toBe(false);
    // Even a shared (org-visible) agent created by someone else counts — a
    // user joining a mature org doesn't need to build their own.
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "create_agent", currentOrgReady: true })).toBe(false);
  });
  it("does not redirect before /me loads", () => {
    expect(shouldEnterOnboarding({ ...base, meLoaded: false })).toBe(false);
  });
  it("does not redirect on a transient /me failure (null step)", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: null })).toBe(false);
  });
  it("does not redirect a dismissed user (they chose to hide it)", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingDismissedAt: "2026-05-22T00:00:00Z" })).toBe(false);
  });
});

describe("resolveInviteeKickoffState", () => {
  it("waits when the team has no knowledge link yet (admin not done)", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "", hasInstallation: false })).toBe("waiting");
    expect(resolveInviteeKickoffState({ treeUrl: "", hasInstallation: true })).toBe("waiting");
  });
  it("waiting wins over no-installation when the tree is also missing (fix the bigger blocker first)", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "", hasInstallation: false })).toBe("waiting");
  });
  it("stops at no-installation when the tree is set but the App was never installed (agent would 403)", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "https://x/y", hasInstallation: false })).toBe("no-installation");
  });
  it("is ready to launch once the tree is set and the App is installed (no repo selection)", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "https://x/y", hasInstallation: true })).toBe("ready");
  });
});

describe("shouldLeaveOnboarding", () => {
  const base = {
    meLoaded: true,
    onboardingStep: "connect" as const,
    currentOrgReady: false,
    onboardingDismissedAt: null,
  };
  it("leaves once connected AND the current org has a usable agent", () => {
    expect(shouldLeaveOnboarding({ ...base, onboardingStep: "completed", currentOrgReady: true })).toBe(true);
  });
  it("stays while the user hasn't connected a computer yet (connect step)", () => {
    expect(shouldLeaveOnboarding(base)).toBe(false);
    expect(shouldLeaveOnboarding({ ...base, currentOrgReady: true })).toBe(false);
  });
  it("stays for a connected user whose current org still has no usable agent", () => {
    expect(shouldLeaveOnboarding({ ...base, onboardingStep: "create_agent", currentOrgReady: false })).toBe(false);
    expect(shouldLeaveOnboarding({ ...base, onboardingStep: "completed", currentOrgReady: false })).toBe(false);
  });
  it("does not strand a merely-dismissed user who returned via Resume into an unready org", () => {
    expect(
      shouldLeaveOnboarding({ ...base, onboardingStep: "create_agent", onboardingDismissedAt: "2026-05-22T00:00:00Z" }),
    ).toBe(false);
  });
  it("waits for /me before deciding", () => {
    expect(
      shouldLeaveOnboarding({ ...base, meLoaded: false, onboardingStep: "completed", currentOrgReady: true }),
    ).toBe(false);
  });
});

describe("needsTreeSetup", () => {
  const base = {
    meLoaded: true,
    onboardingCompletedAt: "2026-06-10T00:00:00Z",
    role: "admin",
    hasTreeBinding: false,
  };
  it("offers recovery to a completed admin whose org has no tree (the skip-the-code-step state)", () => {
    expect(needsTreeSetup(base)).toBe(true);
  });
  it("does not offer once the org already has a tree binding", () => {
    expect(needsTreeSetup({ ...base, hasTreeBinding: true })).toBe(false);
  });
  it("excludes members — they never own the team tree", () => {
    expect(needsTreeSetup({ ...base, role: "member" })).toBe(false);
    expect(needsTreeSetup({ ...base, role: null })).toBe(false);
  });
  it("does not offer to a user still in onboarding (no terminal flag yet)", () => {
    expect(needsTreeSetup({ ...base, onboardingCompletedAt: null })).toBe(false);
  });
  it("waits for /me before deciding", () => {
    expect(needsTreeSetup({ ...base, meLoaded: false })).toBe(false);
  });
});
