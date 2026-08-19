// @vitest-environment happy-dom

import type { MeChatRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter, Route, Routes, useNavigationType } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileShell } from "../shell.js";
import { MobileWorkPage } from "../work.js";

const authMock = vi.hoisted(() => ({
  value: {
    agentId: "human-agent-self",
    organizationId: "org-1",
    meLoaded: true,
    onboardingStep: "completed" as const,
    onboardingDismissedAt: null,
    onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
    currentOrgHasPersonalAgent: true,
  },
}));
const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
  listMeChatSourceCounts: vi.fn(),
  listNeedYouRequests: vi.fn(),
}));

function chatRow(overrides: Partial<MeChatRow> = {}): MeChatRow {
  return {
    chatId: overrides.chatId ?? "chat-1",
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Pinned planning",
    topic: overrides.topic ?? "Pinned planning",
    description: overrides.description ?? null,
    participants: overrides.participants ?? [],
    participantCount: overrides.participantCount ?? 0,
    lastMessageAt: overrides.lastMessageAt ?? "2026-07-24T05:00:00.000Z",
    lastMessagePreview: overrides.lastMessagePreview ?? "Keep the selected quick view after returning.",
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
    pinnedAt: overrides.pinnedAt ?? null,
    activityAt: overrides.activityAt ?? null,
  };
}

vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../api/me-chats.js", () => meChatMocks);
vi.mock("../../../hooks/use-admin-ws.js", () => ({ useAdminWs: () => undefined }));
vi.mock("../../../components/team-switch-overlay.js", () => ({ TeamSwitchOverlay: () => null }));
// Stub the heavy chat-detail so we can drive the back affordance directly.
vi.mock("../../workspace/center/index.js", () => ({
  CenterPanel: ({ onShowConversations }: { onShowConversations: (() => void) | null }) => (
    <button type="button" aria-label="back" onClick={() => onShowConversations?.()}>
      back
    </button>
  ),
}));

let lastNavType = "";
function NavProbe() {
  lastNavType = useNavigationType();
  return null;
}

describe("MobileWorkPage back navigation", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listNeedYouRequests.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({
      priorityRows: { pinned: [] },
      rows: [],
      nextCursor: null,
    });
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
    meChatMocks.listNeedYouRequests.mockResolvedValue({ items: [], total: 0 });
    lastNavType = "";
  });

  it("replaces the detail entry on back so browser Back does not reopen it", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Start on the chat detail (c=chat-1) with the list already behind it.
    harness.render(
      <MemoryRouter initialEntries={["/m/chat", "/m/chat?c=chat-1"]}>
        <QueryClientProvider client={queryClient}>
          <NavProbe />
          <Routes>
            <Route path="/m/chat" element={<MobileWorkPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="back"]');
    expect(back).not.toBeNull();
    expect(lastNavType).toBe("POP"); // initial

    await act(async () => {
      back?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();
    await harness.waitFor(() => expect(harness.container.textContent).toContain("No active chats"));

    // clearChat must REPLACE the detail with the list (not PUSH), so the
    // browser Back button / swipe cannot reopen the chat detail just exited.
    expect(lastNavType).toBe("REPLACE");
  });

  it("preserves the selected quick view after opening a chat and returning", async () => {
    const pinned = chatRow({ pinnedAt: "2026-07-24T05:30:00.000Z" });
    meChatMocks.listMeChats.mockResolvedValue({
      priorityRows: { pinned: [pinned] },
      rows: [pinned],
      nextCursor: null,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    harness.render(
      <MemoryRouter initialEntries={["/m/chat"]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/m/chat" element={<MobileWorkPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await harness.waitFor(() => expect(harness.container.textContent).toContain("Pinned planning"));
    const pinnedQuickView = [...harness.container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Pinned"),
    );
    expect(pinnedQuickView).not.toBeNull();

    await act(async () => {
      pinnedQuickView?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();
    expect(pinnedQuickView?.getAttribute("aria-pressed")).toBe("true");

    const chatCard = harness.container.querySelector<HTMLButtonElement>('[data-mobile-card="work"]');
    await act(async () => {
      chatCard?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();
    expect(harness.container.querySelector('button[aria-label="back"]')).not.toBeNull();

    await act(async () => {
      harness.container
        .querySelector<HTMLButtonElement>('button[aria-label="back"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();

    const restoredPinnedQuickView = [...harness.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Pinned"),
    );
    expect(restoredPinnedQuickView?.getAttribute("aria-pressed")).toBe("true");
    expect(harness.container.textContent).toContain("Pinned planning");
  });

  it("keeps the Chat list scroll offset after opening a conversation and going back", async () => {
    const rows = Array.from({ length: 24 }, (_, index) =>
      chatRow({
        chatId: `chat-${index + 1}`,
        title: `Thread ${index + 1}`,
        topic: `Thread ${index + 1}`,
      }),
    );
    meChatMocks.listMeChats.mockResolvedValue({
      priorityRows: { pinned: [] },
      rows,
      nextCursor: null,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    harness.render(
      <MemoryRouter initialEntries={["/m/chat"]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/m/chat" element={<MobileWorkPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await harness.waitFor(() => expect(harness.container.textContent).toContain("Thread 1"));
    const pane = harness.container.querySelector("[data-mobile-work-list-pane]");
    const scroller = pane?.querySelector<HTMLElement>(".overflow-y-auto");
    expect(pane?.getAttribute("data-mobile-work-list-pane")).toBe("active");
    expect(scroller).not.toBeNull();
    if (!scroller) throw new Error("Missing Chat list scroller");

    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2400 });
    scroller.scrollTop = 640;

    const chatCard = harness.container.querySelector<HTMLButtonElement>('[data-mobile-card="work"]');
    await act(async () => {
      chatCard?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();
    expect(harness.container.querySelector('button[aria-label="back"]')).not.toBeNull();
    expect(pane?.getAttribute("data-mobile-work-list-pane")).toBe("parked");
    expect(scroller.scrollTop).toBe(640);

    await act(async () => {
      harness.container
        .querySelector<HTMLButtonElement>('button[aria-label="back"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();

    const restoredPane = harness.container.querySelector("[data-mobile-work-list-pane]");
    const restoredScroller = restoredPane?.querySelector<HTMLElement>(".overflow-y-auto");
    expect(restoredPane?.getAttribute("data-mobile-work-list-pane")).toBe("active");
    expect(restoredScroller).toBe(scroller);
    expect(restoredScroller?.scrollTop).toBe(640);
    expect(harness.container.textContent).toContain("Thread 1");
  });

  it("restores near-max list scroll after MobileShell hides the bottom tabs", async () => {
    const rows = Array.from({ length: 24 }, (_, index) =>
      chatRow({
        chatId: `chat-${index + 1}`,
        title: `Thread ${index + 1}`,
        topic: `Thread ${index + 1}`,
      }),
    );
    meChatMocks.listMeChats.mockResolvedValue({
      priorityRows: { pinned: [] },
      rows,
      nextCursor: null,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    harness.render(
      <MemoryRouter initialEntries={["/m/chat"]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route element={<MobileShell />}>
              <Route path="/m/chat" element={<MobileWorkPage />} />
            </Route>
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await harness.waitFor(() => expect(harness.container.textContent).toContain("Thread 1"));
    expect(harness.container.querySelector('nav[aria-label="Mobile"]')).not.toBeNull();

    const scroller = harness.container.querySelector<HTMLElement>("[data-mobile-work-list-pane] .overflow-y-auto");
    expect(scroller).not.toBeNull();
    if (!scroller) throw new Error("Missing Chat list scroller");

    const listViewport = 400;
    const detailViewport = 480;
    const contentHeight = 2400;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => currentViewport });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: contentHeight });
    let currentViewport = listViewport;
    scroller.scrollTop = contentHeight - listViewport - 10;

    const chatCard = harness.container.querySelector<HTMLButtonElement>('[data-mobile-card="work"]');
    await act(async () => {
      chatCard?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();

    expect(harness.container.querySelector('nav[aria-label="Mobile"]')).toBeNull();
    const parkedPane = harness.container.querySelector<HTMLElement>("[data-mobile-work-list-pane]");
    expect(Number.parseFloat(parkedPane?.style.height ?? "")).toBe(listViewport);

    currentViewport = detailViewport;
    scroller.scrollTop = Math.min(scroller.scrollTop, contentHeight - currentViewport);

    await act(async () => {
      harness.container
        .querySelector<HTMLButtonElement>('button[aria-label="back"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();

    currentViewport = listViewport;
    expect(harness.container.querySelector('nav[aria-label="Mobile"]')).not.toBeNull();
    expect(scroller.scrollTop).toBe(contentHeight - listViewport - 10);
  });
});
