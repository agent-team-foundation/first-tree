// @vitest-environment happy-dom

import type { MeChatRow, OrgBrief } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAskAgentNavLock, clearAskAgentNavLocks } from "../chat/ask-agent-nav-lock.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    agentId: "human-1" as string | null,
    role: "admin" as string | null,
    teamDisplayName: "Team One" as string | null,
    currentMembership: { id: "mem-1" } as { id: string } | null,
    switchingOrg: null as OrgBrief | null,
    setSwitchingOrg: vi.fn(),
    selectOrganization: vi.fn(),
    refreshMe: vi.fn(),
    logout: vi.fn(),
    user: { displayName: "Gandy", username: "gandy", avatarUrl: null } as unknown,
  },
}));

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
}));

const orgAgentsMock = vi.hoisted(() => ({
  value: { items: [] as unknown[], nextCursor: null },
  isLoading: false,
}));

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

const versionMock = vi.hoisted(() => ({ value: true }));

const disconnectMock = vi.hoisted(() => ({
  value: { rows: [{ id: "computer-1" }] as unknown[], firstHostname: "gandy-macbook" as string | null },
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => "xl",
}));

vi.mock("../../hooks/use-version-check.js", () => ({
  useNewVersionAvailable: () => versionMock.value,
}));

vi.mock("../../hooks/use-disconnected-computers.js", () => ({
  useDisconnectedComputers: () => disconnectMock.value,
}));

vi.mock("../../hooks/use-mobile-experience.js", () => ({
  useMobileExperienceState: () => ({ settled: false, enabled: false }),
}));

vi.mock("../../api/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/client.js")>();
  return {
    ...original,
    api: { ...original.api, get: apiMocks.get },
  };
});

vi.mock("../../api/me-chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/me-chats.js")>()),
  listMeChats: meChatMocks.listMeChats,
}));

vi.mock("../../lib/use-org-agents.js", () => ({
  useOrgAgents: () => ({ data: orgAgentsMock.value, isLoading: orgAgentsMock.isLoading }),
}));

// Only the org-switch veil (not a navigation exit) and the two controls that
// are explicitly allowed to keep working while locked (external support
// links, pure theme toggle) are stubbed. Every navigation-capable host
// control — TeamSwitcher, UserMenu, DisconnectChip, NewVersionChip,
// CommandPalette, nav tabs — is the REAL component under test.
vi.mock("../team-switch-overlay.js", () => ({ TeamSwitchOverlay: () => null }));
vi.mock("../support-menu.js", () => ({ SupportMenu: () => null }));
vi.mock("../ui/theme-toggle.js", () => ({ ThemeToggle: () => null }));

const NOW = "2026-05-28T12:00:00.000Z";

const ORGS: OrgBrief[] = [
  { id: "org-1", name: "team-one", displayName: "Team One", role: "admin" },
  { id: "org-2", name: "team-two", displayName: "Team Two", role: "member" },
];

function chatRow(): MeChatRow {
  const participants = [
    {
      agentId: "agent-1",
      name: "nova",
      displayName: "Nova",
      type: "agent" as const,
      avatarColorToken: null,
      avatarImageUrl: null,
    },
  ];
  return {
    chatId: "chat-1",
    type: "group",
    membershipKind: "participant",
    createdByMe: false,
    source: "manual",
    entityType: null,
    title: "Launch planning",
    topic: "Release train",
    description: null,
    participants,
    participantCount: participants.length,
    lastMessageAt: NOW,
    lastMessagePreview: "Ship it.",
    unreadMentionCount: 0,
    openRequestCount: 0,
    canReply: true,
    engagementStatus: "active",
    liveActivity: null,
    failedAgentIds: [],
    busyAgentIds: [],
    chatHasExplicitMentionToMe: false,
    pinnedAt: null,
    activityAt: null,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderLayout(initialEntry: string): Promise<{ container: HTMLElement; root: Root }> {
  const { Layout } = await import("../layout.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <QueryClientProvider client={createClient()}>
          <LocationProbe />
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<div data-testid="workspace-surface">workspace surface</div>} />
              <Route path="/quickstart" element={<div data-testid="trial-surface">trial surface</div>} />
              <Route path="/context" element={<div>context surface</div>} />
              <Route path="/team" element={<div>team surface</div>} />
              <Route path="/settings" element={<div>settings surface</div>} />
              <Route path="/settings/account" element={<div>account settings surface</div>} />
              <Route path="/settings/computers" element={<div>computers settings surface</div>} />
              <Route path="/onboarding" element={<div>onboarding surface</div>} />
            </Route>
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

function locationText(container: ParentNode): string {
  return container.querySelector('[data-testid="location"]')?.textContent ?? "";
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent === text) ?? null;
}

function menuItemByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function linkByText(scope: ParentNode, text: string): HTMLAnchorElement | null {
  return [...scope.querySelectorAll("a")].find((anchor) => anchor.textContent === text) ?? null;
}

function commandItemByText(text: string): HTMLElement | null {
  return (
    [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) => item.textContent?.includes(text)) ??
    null
  );
}

async function engageLock(): Promise<void> {
  await act(async () => {
    addAskAgentNavLock({ chatId: "chat-1", requestId: "req-1" });
  });
  await flush();
}

async function releaseLock(): Promise<void> {
  await act(async () => {
    clearAskAgentNavLocks();
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  clearAskAgentNavLocks();
  authMock.value = {
    organizationId: "org-1",
    agentId: "human-1",
    role: "admin",
    teamDisplayName: "Team One",
    currentMembership: { id: "mem-1" },
    switchingOrg: null,
    setSwitchingOrg: vi.fn(),
    selectOrganization: vi.fn(() => Promise.resolve()),
    refreshMe: vi.fn(() => Promise.resolve()),
    logout: vi.fn(),
    user: { displayName: "Gandy", username: "gandy", avatarUrl: null },
  };
  versionMock.value = true;
  disconnectMock.value = { rows: [{ id: "computer-1" }], firstHostname: "gandy-macbook" };
  meChatMocks.listMeChats.mockResolvedValue({ rows: [chatRow()], nextCursor: null });
  apiMocks.get.mockImplementation((path: string) => {
    if (path === "/me/organizations") return Promise.resolve(ORGS);
    return Promise.resolve({});
  });
});

afterEach(() => {
  clearAskAgentNavLocks();
  document.body.innerHTML = "";
});

describe("Layout Ask agent navigation lock", () => {
  it("locks top tabs and the Jump-to palette while an attempt is pending, then restores them", async () => {
    const { container, root } = await renderLayout("/?review=need-you");
    expect(container.querySelector('[data-testid="workspace-surface"]')).not.toBeNull();
    // The external brand link is a read-only new-tab exit and must stay a
    // real anchor regardless of the lock.
    const brandLink = container.querySelector('a[target="_blank"]');
    expect(brandLink).not.toBeNull();

    await engageLock();

    // Every top tab is now an inert disabled button — no navigable anchors.
    expect(container.querySelector('a[href="/team"]')).toBeNull();
    expect(container.querySelector('a[href="/context"]')).toBeNull();
    const lockedTabs = [...container.querySelectorAll("button")].filter((button) =>
      button.getAttribute("aria-label")?.includes("unavailable while waiting for the agent reply"),
    );
    expect(lockedTabs).toHaveLength(4);
    for (const tab of lockedTabs) expect(tab.disabled).toBe(true);
    // The brand link is NOT one of them.
    expect(container.querySelector('a[target="_blank"]')).not.toBeNull();

    await click(buttonByText(container, "Team"));
    expect(locationText(container)).toBe("/?review=need-you");
    expect(container.querySelector('[data-testid="workspace-surface"]')).not.toBeNull();

    // The palette cannot be opened via the Jump button or ⌘K while locked.
    await click(container.querySelector('button[aria-label^="Jump to"]'));
    expect(document.body.textContent).not.toContain("Jump to chat or teammate…");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.body.textContent).not.toContain("Jump to chat or teammate…");

    // Unlock: tabs navigate again (back to real anchors) and the palette opens.
    await releaseLock();
    expect(container.querySelector('a[href="/team"]')).not.toBeNull();
    await click(linkByText(container, "Team"));
    expect(locationText(container)).toBe("/team");

    await click(container.querySelector('button[aria-label^="Jump to"]'));
    await waitForText("Launch planning");
    await click(commandItemByText("Launch planning"));
    expect(locationText(container)).toBe("/?c=chat-1");

    await act(async () => root.unmount());
  });

  it("dismisses an already-open palette jump without navigating when the attempt is pending", async () => {
    const { container, root } = await renderLayout("/?review=need-you");

    // Palette opens BEFORE the attempt starts…
    await click(container.querySelector('button[aria-label^="Jump to"]'));
    await waitForText("Launch planning");

    // …then the Ask agent attempt engages the lock.
    await engageLock();

    // The destination is dismissed without leaving the review surface.
    await click(commandItemByText("Launch planning"));
    expect(locationText(container)).toBe("/?review=need-you");
    expect(document.body.textContent).not.toContain("Jump to chat or teammate…");
    expect(container.querySelector('[data-testid="workspace-surface"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps the real TeamSwitcher inert while locked, including a menu opened before the attempt", async () => {
    const { container, root } = await renderLayout("/?review=need-you");
    const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Switch team"]');

    // Menu opens BEFORE the attempt starts; the other team is visible.
    await click(trigger());
    await waitForText("Team Two");

    await engageLock();
    expect(trigger()?.disabled).toBe(true);

    // Every surface-leaving row is VISIBLY inert — not only handler-guarded:
    // the other-team switch row, Leave, Create, own-agent setup, and Invite.
    const teamTwoRow = menuItemByText(container, "Team Two");
    expect(teamTwoRow?.disabled).toBe(true);
    const createRow = menuItemByText(container, "Create team");
    expect(createRow?.disabled).toBe(true);
    expect(menuItemByText(container, "Use your own agent")?.disabled).toBe(true);
    expect(menuItemByText(container, "Leave team")?.disabled).toBe(true);
    expect(menuItemByText(container, "Invite teammates")?.disabled).toBe(true);

    // The switch action boundary re-checks the lock: no cache-clearing
    // selectOrganization, no navigation.
    await click(teamTwoRow);
    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();
    expect(locationText(container)).toBe("/?review=need-you");
    expect(container.querySelector('[data-testid="workspace-surface"]')).not.toBeNull();

    // Create cannot reach the setup modal (whose success path calls
    // selectOrganization and navigates to /onboarding), and own-agent setup
    // cannot leave the current work surface.
    await click(createRow);
    expect(document.body.textContent).not.toContain("Create a new team");
    await click(menuItemByText(container, "Use your own agent"));
    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();
    expect(locationText(container)).toBe("/?review=need-you");

    // Unlock: the same rows act again — team switch…
    await releaseLock();
    expect(trigger()?.disabled).toBe(false);
    const teamTwoRowAfter = menuItemByText(container, "Team Two");
    expect(teamTwoRowAfter?.disabled).toBe(false);
    await click(teamTwoRowAfter);
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-2");

    // …and Create reaches the setup modal.
    await click(trigger());
    await waitForText("Create team");
    await click(menuItemByText(container, "Create team"));
    await waitForText("Create a new team");

    await act(async () => root.unmount());
  });

  it("keeps the real UserMenu inert while locked: no account settings, no sign out", async () => {
    const { container, root } = await renderLayout("/?review=need-you");
    const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label^="User menu"]');

    // Menu opened BEFORE the attempt: both items are visibly inert AND
    // blocked at their action boundaries.
    await click(trigger());
    await waitForText("Account settings");
    await engageLock();
    expect(trigger()?.disabled).toBe(true);
    const accountItem = menuItemByText(container, "Account settings");
    expect(accountItem?.disabled).toBe(true);
    const signOutItem = menuItemByText(container, "Sign out");
    expect(signOutItem?.disabled).toBe(true);
    await click(accountItem);
    expect(locationText(container)).toBe("/?review=need-you");
    await click(signOutItem);
    expect(authMock.value.logout).not.toHaveBeenCalled();
    expect(locationText(container)).toBe("/?review=need-you");

    // Unlock (menu still open): Account settings navigates again.
    await releaseLock();
    await click(menuItemByText(container, "Account settings"));
    expect(locationText(container)).toBe("/settings/account");

    await act(async () => root.unmount());
  });

  it("keeps the real DisconnectChip and NewVersionChip inert while locked", async () => {
    const { container, root } = await renderLayout("/?review=need-you");
    const disconnect = buttonByText(container, "Computer disconnected");
    const update = buttonByText(container, "Update available");
    expect(disconnect).not.toBeNull();
    expect(update).not.toBeNull();
    expect(disconnect?.disabled).toBe(false);
    expect(update?.disabled).toBe(false);

    await engageLock();
    expect(disconnect?.disabled).toBe(true);
    expect(update?.disabled).toBe(true);
    await click(disconnect);
    expect(locationText(container)).toBe("/?review=need-you");

    await releaseLock();
    expect(disconnect?.disabled).toBe(false);
    await click(disconnect);
    expect(locationText(container)).toBe("/settings/computers");

    await act(async () => root.unmount());
  });

  it("keeps the trial onboarding CTA inert while locked, including a same-frame stale link click", async () => {
    const { container, root } = await renderLayout("/quickstart?c=chat-1");
    expect(container.querySelector('[data-testid="trial-surface"]')).not.toBeNull();
    // Unlocked: the CTA is a real onboarding link.
    const ctaAnchor = container.querySelector('a[href="/onboarding"]');
    if (!ctaAnchor) throw new Error("Expected onboarding CTA anchor");

    // Same-frame race: the lock is published but React has not yet swapped
    // the link for the disabled button. The link's own click boundary must
    // preventDefault — dispatchEvent returns false when it did.
    let clickResult = true;
    await act(async () => {
      addAskAgentNavLock({ chatId: "chat-1", requestId: "req-1" });
      clickResult = ctaAnchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(clickResult).toBe(false);
    expect(locationText(container)).toBe("/quickstart?c=chat-1");

    // Committed state: no navigable CTA anchor; the disabled replacement does not move.
    expect(container.querySelector('a[href="/onboarding"]')).toBeNull();
    const cta = buttonByText(container, "Set up First Tree for your team");
    expect(cta?.disabled).toBe(true);
    await click(cta);
    expect(locationText(container)).toBe("/quickstart?c=chat-1");
    expect(container.querySelector('[data-testid="trial-surface"]')).not.toBeNull();

    // Unlock: the link is restored and navigates.
    await releaseLock();
    const ctaLink = container.querySelector('a[href="/onboarding"]');
    expect(ctaLink).not.toBeNull();
    await click(ctaLink);
    expect(locationText(container)).toBe("/onboarding");

    await act(async () => root.unmount());
  });
});
