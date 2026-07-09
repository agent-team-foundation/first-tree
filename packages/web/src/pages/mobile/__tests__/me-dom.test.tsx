// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const authMock = vi.hoisted(() => {
  const memberships: MeMembership[] = [];
  const currentMembership: MeMembership | null = null;
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
  TeamSwitcher: () => <button type="button">Switch team</button>,
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
    authMock.value.logout = vi.fn();
  });

  it("renders account, team, preference, support, and sign-out controls without admin panels", async () => {
    await renderMePage(harness);

    expect(harness.container.textContent).toContain("Gandy");
    expect(harness.container.textContent).toContain("@gandy");
    expect(harness.container.textContent).toContain("Acme Research");
    expect(harness.container.textContent).toContain("Switch team");
    expect(harness.container.textContent).toContain("Switch theme");
    expect(harness.container.textContent).toContain("Desktop settings");
    expect(harness.container.textContent).toContain("Support");
    expect(harness.container.textContent).toContain("Sign out");
    expect(harness.container.textContent).not.toContain("Agent runtime");
    expect(harness.container.textContent).not.toContain("Context tree setup");
    expect(harness.container.textContent).not.toContain("GitHub integration");

    const signOut =
      [...harness.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign out")) ??
      null;
    signOut?.click();
    expect(authMock.value.logout).toHaveBeenCalledTimes(1);
  });
});
