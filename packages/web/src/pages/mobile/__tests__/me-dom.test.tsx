// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const authMock = vi.hoisted(() => {
  const memberships: MeMembership[] = [
    {
      id: "member-self",
      organizationId: "org-1",
      organizationName: "Acme Research",
      role: "admin",
      agentId: "human-agent-self",
      orgHasOtherMembers: true,
      hasUsableAgent: true,
      hasPersonalAgent: true,
      onboardingSuppressedAt: null,
      onboardingSuppressedReason: null,
      onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      id: "member-globex",
      organizationId: "org-2",
      organizationName: "Globex Labs",
      role: "member",
      agentId: "human-agent-globex",
      orgHasOtherMembers: true,
      hasUsableAgent: true,
      hasPersonalAgent: false,
      onboardingSuppressedAt: null,
      onboardingSuppressedReason: null,
      onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
    },
  ];
  const currentMembership: MeMembership | null = memberships[0] ?? null;
  return {
    logout: vi.fn(),
    value: {
      isAuthenticated: true,
      meLoaded: true,
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships,
      currentMembership,
      organizationId: "org-1",
      memberId: "member-self",
      role: "admin",
      agentId: "human-agent-self",
      teamDisplayName: "Acme Research",
      orgHasOtherMembers: true,
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: true,
      docsEnabled: false,
      onboardingStep: "completed" as const,
      onboardingDismissedAt: null,
      onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
      dismissOnboarding: vi.fn(async () => undefined),
      restoreOnboarding: vi.fn(async () => undefined),
      markOnboardingCompleted: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      adoptTokens: vi.fn(async () => undefined),
      selectOrganization: vi.fn(async () => undefined),
      switchingOrg: null,
      setSwitchingOrg: vi.fn(),
      refreshMe: vi.fn(async () => undefined),
      logout: vi.fn(),
    },
  };
});

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../components/team-switcher.js", () => ({
  TeamSwitcher: () => (
    <button type="button" aria-haspopup="menu" data-testid="desktop-team-switcher">
      Switch team
    </button>
  ),
}));

vi.mock("../../../components/ui/theme-toggle.js", () => ({
  ThemeToggle: () => <button type="button">Switch theme</button>,
}));

function renderMePage(harness: DomHarness) {
  return import("../me.js").then(({ MobileMePage }) => {
    harness.render(
      <MemoryRouter>
        <MobileMePage />
      </MemoryRouter>,
    );
  });
}

describe("MobileMePage", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    // Async to match the real AuthContext contract — logout() now resolves
    // after the local-data purge (SEC-042). The mobile button passes it
    // straight to onClick, which tolerates the returned promise.
    authMock.value.logout = vi.fn(async () => undefined);
  });

  it("renders account, team, preference, support, and sign-out controls without admin panels", async () => {
    await renderMePage(harness);

    expect(harness.container.textContent).toContain("Gandy");
    expect(harness.container.textContent).toContain("@gandy");
    expect(harness.container.textContent).toContain("Acme Research");
    expect(harness.container.textContent).toContain("Change team");
    expect(harness.container.textContent).toContain("Switch theme");
    expect(harness.container.textContent).toContain("Community support");
    expect(harness.container.querySelector('a[href="https://discord.gg/nCG9wsbbvF"]')).not.toBeNull();
    expect(harness.container.textContent).toContain("Sign out");
    expect(harness.container.textContent).not.toContain("Desktop settings");
    expect(harness.container.textContent).not.toContain("Agent runtime");
    expect(harness.container.textContent).not.toContain("Context tree setup");
    expect(harness.container.textContent).not.toContain("GitHub integration");
    expect(harness.container.querySelector('a[href^="/settings"]')).toBeNull();

    const signOut =
      [...harness.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign out")) ??
      null;
    signOut?.click();
    expect(authMock.value.logout).toHaveBeenCalledTimes(1);
  });

  it("opens team switching in a mobile sheet instead of the desktop anchored menu", async () => {
    await renderMePage(harness);

    expect(harness.container.querySelector('[data-testid="desktop-team-switcher"]')).toBeNull();

    const trigger =
      [...harness.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Change team")) ??
      null;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();

    const sheet = harness.container.querySelector('[data-mobile-team-sheet="true"]');
    expect(sheet?.getAttribute("role")).toBe("dialog");
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    expect(sheet?.textContent).toContain("Acme Research");
    expect(sheet?.textContent).toContain("Globex Labs");
    expect(sheet?.textContent).not.toContain("Team options");
    expect(sheet?.textContent).not.toContain("Create new team");
    expect(sheet?.textContent).not.toContain("Join with invite link");
    expect(sheet?.textContent).not.toContain("Invite teammates");
    expect(sheet?.textContent).not.toContain("Leave this team");
    expect(sheet?.querySelector('[role="menu"]')).toBeNull();
  });
});
