// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobilePage, MobileSignalChip } from "../components.js";
import { MobileShell } from "../shell.js";
import { MobileWorkPage } from "../work.js";

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
  listMeChatSourceCounts: vi.fn(),
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
            <Route path="/m/work" element={<div>work content</div>} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderUnifiedWorkShell(harness: DomHarness) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.render(
    <MemoryRouter initialEntries={["/m/work"]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<MobileShell />}>
            <Route path="/m/work" element={<MobileWorkPage />} />
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
    meChatMocks.listMeChatSourceCounts.mockReset();
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
  });

  it("keeps bottom tabs on primary tabs and hides them for chat detail", async () => {
    renderShell(harness, "/m/work");
    await harness.flush();
    expect(harness.container.querySelector('nav[aria-label="Mobile"]')).not.toBeNull();

    harness.cleanup();
    harness = createDomHarness();

    renderShell(harness, "/m/work?c=chat-1");
    await harness.flush();
    expect(harness.container.textContent).toContain("work content");
    expect(harness.container.querySelector('nav[aria-label="Mobile"]')).toBeNull();
    expect(harness.container.textContent).not.toContain("Current team");
  });

  it("omits duplicate root-tab top titles and keeps team switching out of mobile chrome", async () => {
    renderShell(harness, "/m/work");
    await harness.flush();

    expect(harness.container.querySelector("header")).toBeNull();
    expect(harness.container.textContent).toContain("Work");
    expect(harness.container.textContent).not.toContain("Chat");
    expect(harness.container.textContent).not.toContain("Current team");
  });

  it("uses the mobile viewport utility and reserves the top safe area", async () => {
    renderShell(harness, "/m/work");
    await harness.flush();

    // Viewport height comes from the .h-dvh-screen utility: dynamic viewport
    // sizing for browser tabs and the WebKit standalone 100vh override live in
    // CSS, rather than an inline height that cannot distinguish display mode.
    // The top safe-area inset is reserved via .pt-safe-top so content does not
    // render under the status bar on notched devices.
    const shell = harness.container.querySelector(".h-dvh-screen");
    expect(shell).not.toBeNull();
    expect((shell as HTMLElement).style.height).toBe("");
    expect(shell?.className).toContain("pt-safe-top");
  });

  it("shares one active-list poller and one source-count poller between shell and Work", async () => {
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [],
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    });
    renderUnifiedWorkShell(harness);

    await harness.waitFor(() => expect(harness.container.textContent).toContain("No active work"));
    expect(meChatMocks.listMeChats).toHaveBeenCalledTimes(1);
    expect(meChatMocks.listMeChatSourceCounts).toHaveBeenCalledTimes(1);
    expect(meChatMocks.listMeChatSourceCounts).toHaveBeenCalledWith(
      { engagement: "active", watching: undefined },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses the high-contrast token for needs-you signal text", () => {
    harness.render(
      <MobileSignalChip signal={{ tone: "needs-you", label: "Needs answer", rank: 0, attention: true }} />,
    );

    const chip = harness.container.querySelector("span");
    expect(chip?.getAttribute("style")).toContain("var(--fg-needs-you-strong)");
  });
});

describe("MobilePage", () => {
  it("is a bounded scroll container so page content can scroll", () => {
    const harness = createDomHarness();
    harness.render(<MobilePage>work feed</MobilePage>);

    const scroller = harness.container.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    // h-full bounds the scroller to the parent height so overflow-y-auto
    // engages; min-h-full would grow with content and never scroll.
    expect(scroller?.className).toContain("h-full");
    expect(scroller?.className).not.toContain("min-h-full");
  });
});
