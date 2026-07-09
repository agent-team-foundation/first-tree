// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileShell } from "../shell.js";

const authMock = vi.hoisted(() => {
  const memberships: MeMembership[] = [];
  const currentMembership: MeMembership | null = null;
  return {
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

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../api/me-chats.js", () => meChatMocks);

vi.mock("../../../hooks/use-admin-ws.js", () => ({
  useAdminWs: () => undefined,
}));

vi.mock("../../../components/team-switcher.js", () => ({
  TeamSwitcher: () => <button type="button">Current team</button>,
}));

vi.mock("../../../components/team-switch-overlay.js", () => ({
  TeamSwitchOverlay: () => null,
}));

function renderShell(harness: DomHarness, path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<MobileShell />}>
            <Route path="/m/today" element={<div>today content</div>} />
            <Route path="/m/chat" element={<div>chat content</div>} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("MobileShell", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockReturnValue(new Promise(() => undefined));
  });

  it("keeps bottom tabs on primary tabs and hides them for chat detail", async () => {
    renderShell(harness, "/m/today");
    await harness.flush();
    expect(harness.container.querySelector('nav[aria-label="Mobile"]')).not.toBeNull();

    harness.cleanup();
    harness = createDomHarness();

    renderShell(harness, "/m/chat?c=chat-1");
    await harness.flush();
    expect(harness.container.textContent).toContain("chat content");
    expect(harness.container.querySelector('nav[aria-label="Mobile"]')).toBeNull();
    expect(harness.container.textContent).not.toContain("Current team");
  });
});
