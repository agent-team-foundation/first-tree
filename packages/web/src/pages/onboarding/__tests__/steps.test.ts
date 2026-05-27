import { describe, expect, it } from "vitest";
import {
  ADMIN_STEPS,
  clampStepIndex,
  getStepSequence,
  INVITEE_STEPS,
  inferInitialStepIndex,
  resolveInviteeKickoffState,
  resolveOnboardingPath,
  shouldEnterOnboarding,
  shouldLeaveOnboarding,
  stepVisualState,
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

describe("stepVisualState", () => {
  it("is complete before, active at, pending after the cursor", () => {
    expect(stepVisualState(0, 2)).toBe("complete");
    expect(stepVisualState(2, 2)).toBe("active");
    expect(stepVisualState(3, 2)).toBe("pending");
  });
});

describe("shouldEnterOnboarding", () => {
  const base = {
    meLoaded: true,
    onboardingStep: "connect" as const,
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
  };
  it("redirects a fresh incomplete user (no computer yet → connect)", () => {
    expect(shouldEnterOnboarding(base)).toBe(true);
  });
  it("redirects a user with a computer but no agent (create_agent)", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "create_agent" })).toBe(true);
  });
  it("bounces a server-completed-but-unfinished user so they resume the Context Tree kickoff", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "completed" })).toBe(true);
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
  it("does not redirect a terminally-finished user (completed step + completed_at set)", () => {
    expect(
      shouldEnterOnboarding({
        ...base,
        onboardingStep: "completed",
        onboardingCompletedAt: "2026-05-22T00:00:00Z",
      }),
    ).toBe(false);
  });
});

describe("resolveInviteeKickoffState", () => {
  it("waits when the team has no knowledge link yet (admin not done)", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "", hasInstallation: false, teamRepoCount: 0 })).toBe("waiting");
    expect(resolveInviteeKickoffState({ treeUrl: "", hasInstallation: true, teamRepoCount: 3 })).toBe("waiting");
  });
  it("waiting wins over no-installation when the tree is also missing (fix the bigger blocker first)", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "", hasInstallation: false, teamRepoCount: 3 })).toBe("waiting");
  });
  it("stops at no-installation when the tree is set but the App was never installed (would 403 in picker)", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "https://x/y", hasInstallation: false, teamRepoCount: 0 })).toBe(
      "no-installation",
    );
    expect(resolveInviteeKickoffState({ treeUrl: "https://x/y", hasInstallation: false, teamRepoCount: 3 })).toBe(
      "no-installation",
    );
  });
  it("confirms from the team's projects when link + install + projects all exist", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "https://x/y", hasInstallation: true, teamRepoCount: 2 })).toBe(
      "confirm",
    );
  });
  it("lets the invitee pick when the team has link + install but listed no projects", () => {
    expect(resolveInviteeKickoffState({ treeUrl: "https://x/y", hasInstallation: true, teamRepoCount: 0 })).toBe(
      "picker",
    );
  });
});

describe("shouldLeaveOnboarding", () => {
  const base = {
    meLoaded: true,
    onboardingStep: "connect" as const,
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
  };
  it("leaves only once terminally complete", () => {
    expect(shouldLeaveOnboarding({ ...base, onboardingCompletedAt: "2026-05-22T00:00:00Z" })).toBe(true);
  });
  it("stays for an incomplete user", () => {
    expect(shouldLeaveOnboarding(base)).toBe(false);
  });
  it("stays for a merely-dismissed user who deliberately returned via Resume", () => {
    expect(shouldLeaveOnboarding({ ...base, onboardingDismissedAt: "2026-05-22T00:00:00Z" })).toBe(false);
  });
  it("waits for /me before deciding", () => {
    expect(shouldLeaveOnboarding({ ...base, meLoaded: false, onboardingCompletedAt: "x" })).toBe(false);
  });
});
