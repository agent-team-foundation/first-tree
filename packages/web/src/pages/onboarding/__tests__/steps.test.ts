import { describe, expect, it } from "vitest";
import {
  ADMIN_STEPS,
  canOfferTeamAgentStart,
  clampStepIndex,
  getStepSequence,
  INVITEE_STEPS,
  inferInitialStepIndex,
  resolveInviteeStartChatState,
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
  it("tracks the 3-step admin setup progress and treats start-chat as the payoff", () => {
    expect(resolveStepProgress("admin", "create-team")).toEqual({ index: 0, total: 3 });
    expect(resolveStepProgress("admin", "connect-computer")).toEqual({ index: 1, total: 3 });
    expect(resolveStepProgress("admin", "create-agent")).toEqual({ index: 2, total: 3 });
    expect(resolveStepProgress("admin", "start-chat")).toBeNull();
  });
  it("tracks the 3-step invitee setup progress and treats start-chat as the payoff", () => {
    expect(resolveStepProgress("invitee", "join-team")).toEqual({ index: 0, total: 3 });
    expect(resolveStepProgress("invitee", "connect-computer")).toEqual({ index: 1, total: 3 });
    expect(resolveStepProgress("invitee", "create-agent")).toEqual({ index: 2, total: 3 });
    expect(resolveStepProgress("invitee", "start-chat")).toBeNull();
  });
});

describe("getStepSequence", () => {
  it("admin sequence shows the full create-team to start-chat path", () => {
    expect(getStepSequence("admin")).toEqual(ADMIN_STEPS);
    expect(ADMIN_STEPS).toEqual(["create-team", "connect-computer", "create-agent", "start-chat"]);
  });
  it("invitee sequence shows the full join-team to start-chat path", () => {
    expect(getStepSequence("invitee")).toEqual(INVITEE_STEPS);
    expect(INVITEE_STEPS).toEqual(["join-team", "connect-computer", "create-agent", "start-chat"]);
  });
  it("connect-computer precedes create-agent in both paths (agent needs a computer)", () => {
    for (const seq of [ADMIN_STEPS, INVITEE_STEPS]) {
      expect(seq.indexOf("connect-computer")).toBeLessThan(seq.indexOf("create-agent"));
    }
  });
  it("GitHub access is not part of either main path", () => {
    expect(ADMIN_STEPS).not.toContain("connect-code" as never);
    expect(INVITEE_STEPS).not.toContain("connect-code" as never);
  });
});

describe("inferInitialStepIndex", () => {
  it("admin: fresh user (connect, unsettled team) starts at team", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "connect", teamSettled: false })).toBe(
      ADMIN_STEPS.indexOf("create-team"),
    );
  });
  it("admin: connected users still start at create-team on a fresh entry", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "connect", teamSettled: true })).toBe(
      ADMIN_STEPS.indexOf("create-team"),
    );
  });
  it("create_agent state still starts at the opening step on a fresh entry", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "create_agent", teamSettled: true })).toBe(
      ADMIN_STEPS.indexOf("create-team"),
    );
  });
  it("completed state still starts at the opening step unless local progress resumes it", () => {
    expect(inferInitialStepIndex("admin", { onboardingStep: "completed", teamSettled: true })).toBe(
      ADMIN_STEPS.indexOf("create-team"),
    );
    expect(inferInitialStepIndex("invitee", { onboardingStep: "completed", teamSettled: true })).toBe(
      INVITEE_STEPS.indexOf("join-team"),
    );
  });
  it("invitee always starts at join-team when no computer exists", () => {
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
    currentOrgHasPersonalAgent: false,
    onboardingSuppressedAt: null,
    // Ignored by the entry gate; present because both gates share the facts type.
    onboardingCompletedAt: null,
  };
  it("redirects a fresh incomplete user (no computer yet → connect)", () => {
    expect(shouldEnterOnboarding(base)).toBe(true);
  });
  it("redirects a connected user whose current org has no personal agent (create_agent)", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "create_agent", currentOrgHasPersonalAgent: false })).toBe(
      true,
    );
  });
  it("redirects an account-completed user who joined an org where they have no personal agent", () => {
    // The whole point of the org-level gate: a returning user who set up an
    // agent in a *prior* org must still create one here.
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "completed", currentOrgHasPersonalAgent: false })).toBe(
      true,
    );
  });
  it("does NOT redirect when connected and the current org already has a personal agent", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "completed", currentOrgHasPersonalAgent: true })).toBe(
      false,
    );
    expect(shouldEnterOnboarding({ ...base, onboardingStep: "create_agent", currentOrgHasPersonalAgent: true })).toBe(
      false,
    );
  });
  it("does not redirect before /me loads", () => {
    expect(shouldEnterOnboarding({ ...base, meLoaded: false })).toBe(false);
  });
  it("does not redirect on a transient /me failure (null step)", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingStep: null })).toBe(false);
  });
  it("does not redirect when the current membership already suppressed auto-open", () => {
    expect(shouldEnterOnboarding({ ...base, onboardingSuppressedAt: "2026-05-22T00:00:00Z" })).toBe(false);
  });
  it("redirects an account-completed user when this membership has not suppressed auto-open", () => {
    expect(
      shouldEnterOnboarding({
        ...base,
        onboardingStep: "completed",
        currentOrgHasPersonalAgent: false,
        onboardingSuppressedAt: null,
      }),
    ).toBe(true);
  });
});

describe("canOfferTeamAgentStart", () => {
  it("offers the install-free start only while the org has a usable agent and no personal one", () => {
    expect(
      canOfferTeamAgentStart({ currentOrgHasUsableAgent: true, currentOrgHasPersonalAgent: false }),
    ).toBe(true);
  });
  it("never offers it on a fresh team or once the member has their own agent", () => {
    expect(
      canOfferTeamAgentStart({ currentOrgHasUsableAgent: false, currentOrgHasPersonalAgent: false }),
    ).toBe(false);
    expect(
      canOfferTeamAgentStart({ currentOrgHasUsableAgent: true, currentOrgHasPersonalAgent: true }),
    ).toBe(false);
    expect(
      canOfferTeamAgentStart({ currentOrgHasUsableAgent: false, currentOrgHasPersonalAgent: true }),
    ).toBe(false);
  });
});

describe("resolveInviteeStartChatState", () => {
  it("is not-ready while either the tree or the GitHub connection is missing", () => {
    expect(resolveInviteeStartChatState({ treeUrl: "", hasInstallation: false })).toBe("not-ready");
    expect(resolveInviteeStartChatState({ treeUrl: "", hasInstallation: true })).toBe("not-ready");
    expect(resolveInviteeStartChatState({ treeUrl: "https://x/y", hasInstallation: false })).toBe("not-ready");
  });
  it("is ready to launch once the tree is set and the App is installed (no repo selection)", () => {
    expect(resolveInviteeStartChatState({ treeUrl: "https://x/y", hasInstallation: true })).toBe("ready");
  });
});

describe("shouldLeaveOnboarding", () => {
  const base = {
    meLoaded: true,
    onboardingStep: "connect" as const,
    currentOrgHasPersonalAgent: false,
    onboardingSuppressedAt: null,
    onboardingCompletedAt: null as string | null,
  };
  it("leaves once connected, the org is ready, AND the membership completion stamp is set", () => {
    expect(
      shouldLeaveOnboarding({
        ...base,
        onboardingStep: "completed",
        currentOrgHasPersonalAgent: true,
        onboardingCompletedAt: "2026-05-31T00:00:00Z",
      }),
    ).toBe(true);
  });
  it("stays after create-agent on a hard reload until the completion stamp is written", () => {
    // The bug: a full reload right after create-agent sees onboardingStep
    // "completed" + a ready org (server infers both the instant the agent comes
    // online), but the membership stamp is still null because start-chat
    // hasn't run. Readiness alone must NOT eject the user.
    expect(
      shouldLeaveOnboarding({
        ...base,
        onboardingStep: "completed",
        currentOrgHasPersonalAgent: true,
        onboardingCompletedAt: null,
      }),
    ).toBe(false);
  });
  it("stays while the user hasn't connected a computer yet (connect step)", () => {
    expect(shouldLeaveOnboarding(base)).toBe(false);
    expect(shouldLeaveOnboarding({ ...base, currentOrgHasPersonalAgent: true })).toBe(false);
  });
  it("stays for a connected user whose current org still has no personal agent", () => {
    expect(shouldLeaveOnboarding({ ...base, onboardingStep: "create_agent", currentOrgHasPersonalAgent: false })).toBe(
      false,
    );
    expect(shouldLeaveOnboarding({ ...base, onboardingStep: "completed", currentOrgHasPersonalAgent: false })).toBe(
      false,
    );
  });
  it("does not strand a merely-dismissed user who returned via Resume into an unready org", () => {
    expect(
      shouldLeaveOnboarding({
        ...base,
        onboardingStep: "create_agent",
        onboardingSuppressedAt: "2026-05-22T00:00:00Z",
      }),
    ).toBe(false);
  });
  it("waits for /me before deciding", () => {
    // Otherwise leave-worthy (ready + stamped) so meLoaded is the only gate under test.
    expect(
      shouldLeaveOnboarding({
        ...base,
        meLoaded: false,
        onboardingStep: "completed",
        currentOrgHasPersonalAgent: true,
        onboardingCompletedAt: "2026-05-31T00:00:00Z",
      }),
    ).toBe(false);
  });
});
