// @vitest-environment happy-dom

import type { MeChatRow, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui/toast.js";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileWorkPage } from "../work.js";

const NOW = "2026-07-09T10:00:00.000Z";

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
      applyOnboardingKickoffStamp: vi.fn(),
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
  listNeedYouRequests: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../api/me-chats.js", () => meChatMocks);

function chatRow(overrides: Partial<MeChatRow> = {}): MeChatRow {
  return {
    chatId: overrides.chatId ?? "chat-1",
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Launch planning",
    topic: overrides.topic ?? "Launch planning",
    description: overrides.description ?? null,
    participants: overrides.participants ?? [
      {
        agentId: "human-agent-self",
        displayName: "Gandy",
        type: "human",
        avatarColorToken: null,
        avatarImageUrl: null,
      },
    ],
    participantCount: overrides.participantCount ?? 1,
    lastMessageAt: overrides.lastMessageAt ?? NOW,
    lastMessagePreview:
      overrides.lastMessagePreview ?? "Please review the launch checklist and decide the next milestone.",
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

function renderWithClient(harness: DomHarness, element: ReactElement, path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Routes>
            <Route path="/m/chat" element={element} />
          </Routes>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * TanStack Query may notify observers on a timer, while the shared DOM
 * harness only flushes microtasks. Keep the macrotask-aware polling local to
 * this Query-backed test file.
 */
async function waitForSettled(harness: DomHarness, assertion: () => void): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await harness.flush();
  }
  throw lastErr;
}

describe("mobile density tiers", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [
        chatRow({
          chatId: "question",
          title: "Release readiness",
          openRequestCount: 1,
          participants: [
            {
              agentId: "human-agent-self",
              displayName: "Gandy",
              type: "human",
              avatarColorToken: null,
              avatarImageUrl: null,
            },
            {
              agentId: "gandy-coder",
              displayName: "gandy-coder",
              type: "agent",
              avatarColorToken: null,
              avatarImageUrl: null,
            },
          ],
        }),
        chatRow({ chatId: "working", title: "Context docs", busyAgentIds: ["agent-1"] }),
        chatRow({ chatId: "recent", title: "Team roster polish" }),
      ],
      priorityRows: { pinned: [] },
      nextCursor: null,
    });
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
    meChatMocks.listNeedYouRequests.mockResolvedValue({
      items: [
        {
          request: { id: "req-1" },
          chat: { id: "pinned-urgent", title: "Pinned urgent work" },
          asker: { agentId: "a-1" },
        },
      ],
      total: 1,
      nextCursor: null,
    });
  });

  afterEach(() => {
    harness.cleanup();
    vi.unstubAllGlobals();
  });

  it("renders one continuous Chat list without promoting ask or recovery states", async () => {
    renderWithClient(harness, <MobileWorkPage />, "/m/chat");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Release readiness"));
    expect(harness.container.textContent).toContain("Chat");

    const sectionHeadings = [...harness.container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(sectionHeadings).toEqual([]);

    const cards = [...harness.container.querySelectorAll<HTMLElement>("[data-mobile-card]")];
    expect(cards).toHaveLength(3);
    expect(cards[0]?.getAttribute("data-mobile-card")).toBe("work");
    expect(cards[0]?.textContent).toContain("Release readiness");
    expect(cards[0]?.querySelector("[data-mobile-primary-action]")).toBeNull();
    expect(cards[1]?.getAttribute("data-mobile-card")).toBe("work");
    expect(cards[1]?.textContent).toContain("Context docs");
    expect(cards[2]?.textContent).toContain("Team roster polish");
  });

  it("gives summaries three lines while keeping dynamic evidence compact", async () => {
    renderWithClient(harness, <MobileWorkPage />, "/m/chat");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Release readiness"));

    const cards = [...harness.container.querySelectorAll<HTMLElement>("[data-mobile-card]")];
    const requestCard = cards.find((card) => card.textContent?.includes("Release readiness"));
    const workingCard = cards.find((card) => card.textContent?.includes("Context docs"));
    const ordinaryCard = cards.find((card) => card.textContent?.includes("Team roster polish"));
    if (!requestCard || !workingCard || !ordinaryCard) throw new Error("Missing expected Chat cards");

    expect(requestCard.querySelector("[data-mobile-card-preview]")?.getAttribute("data-line-clamp")).toBe("3");
    expect(workingCard.getAttribute("style")).toContain("min-height: calc(var(--sp-20) + var(--sp-8))");
    expect(workingCard.querySelector("[data-mobile-card-preview]")?.className).toContain("text-mobile-body");
    expect(workingCard.querySelector("[data-mobile-card-preview]")?.className).toContain("truncate");
    expect(workingCard.querySelector("[data-mobile-card-dynamic]")?.textContent).toContain("Working");
    expect(workingCard.querySelector("[data-mobile-card-preview]")?.getAttribute("data-line-clamp")).toBe("1");
    expect(ordinaryCard.querySelector("[data-mobile-card-preview]")?.getAttribute("data-line-clamp")).toBe("3");
    expect(ordinaryCard.querySelector("[data-mobile-card-preview]")?.className).not.toContain("truncate");
    expect(workingCard.querySelector("[data-mobile-card-menu]")).toBeNull();
    expect(harness.container.querySelector("[data-mobile-swipe-surface]")).toBeNull();
  });

  it("shows the request-level Need you count separately from pinned and unread chat counts", async () => {
    const pinnedAttention = chatRow({
      chatId: "pinned-attention",
      title: "Pinned urgent work",
      openRequestCount: 1,
      pinnedAt: "2026-07-09T11:00:00.000Z",
    });
    const pinnedQuiet = chatRow({
      chatId: "pinned-quiet",
      title: "Pinned quiet work",
      pinnedAt: "2026-07-09T10:00:00.000Z",
    });
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [pinnedAttention, pinnedQuiet],
      priorityRows: { pinned: [pinnedAttention, pinnedQuiet] },
      nextCursor: null,
    });
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({
      counts: { manual: { chatCount: 3, unreadChatCount: 2 } },
    });

    renderWithClient(harness, <MobileWorkPage />, "/m/chat");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Pinned urgent work"));

    const needYou = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Need you, 1 question"]');
    expect(needYou?.textContent).toContain("1");
    const chips = [...harness.container.querySelectorAll<HTMLButtonElement>("[data-mobile-work-quick-views] button")];
    expect(chips.find((chip) => chip.textContent?.includes("Unread"))?.textContent).toContain("2");
    expect(chips.find((chip) => chip.textContent?.includes("Pinned"))?.textContent).toContain("2");
    const pinnedCard = [...harness.container.querySelectorAll<HTMLElement>('[data-mobile-card="work"]')].find((card) =>
      card.textContent?.includes("Pinned quiet work"),
    );
    expect(pinnedCard?.querySelector("[data-mobile-card-preview]")?.getAttribute("data-line-clamp")).toBe("3");
  });

  it("renders card previews with inline markdown peeled, not as literal markers", async () => {
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [
        chatRow({
          chatId: "md",
          title: "Markdown preview",
          openRequestCount: 0,
          description: "**Task:** run the seed (`first-tree-seed`)",
        }),
      ],
      priorityRows: { pinned: [] },
      nextCursor: null,
    });
    renderWithClient(harness, <MobileWorkPage />, "/m/chat");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Markdown preview"));

    const preview = harness.container.querySelector("[data-mobile-card-preview]");
    expect(preview?.textContent).toBe("Task: run the seed (first-tree-seed)");
    expect(preview?.textContent).not.toContain("**");
    expect(preview?.textContent).not.toContain("`");
  });

  it("mounts the initial row budget, appends the next batch near the sentinel, and lazy-loads avatars", async () => {
    let activeObserver: TestIntersectionObserver | null = null;
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "50% 0%";
      readonly thresholds = [0];

      constructor(private readonly callback: IntersectionObserverCallback) {
        activeObserver = this;
      }

      disconnect(): void {}
      observe(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve(): void {}

      trigger(): void {
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this);
      }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const rows = Array.from({ length: 50 }, (_, index) =>
      chatRow({
        chatId: `progressive-${index}`,
        title: `Progressive ${index}`,
        participants: [
          {
            agentId: "human-agent-self",
            displayName: "Gandy",
            type: "human",
            avatarColorToken: null,
            avatarImageUrl: null,
          },
          {
            agentId: `agent-${index}`,
            displayName: `Agent ${index}`,
            type: "agent",
            avatarColorToken: null,
            avatarImageUrl: `https://example.com/${index}.png`,
          },
        ],
      }),
    );
    meChatMocks.listMeChats.mockResolvedValue({
      rows,
      priorityRows: { pinned: [] },
      nextCursor: null,
    });

    renderWithClient(harness, <MobileWorkPage />, "/m/chat");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Progressive 0"));

    const list = harness.container.querySelector("[data-mobile-work-list]");
    expect(list?.getAttribute("data-mobile-work-rendered")).toBe("16");
    expect(list?.getAttribute("data-mobile-work-total")).toBe("50");
    expect(harness.container.querySelectorAll("[data-mobile-card]")).toHaveLength(16);
    expect(harness.container.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(activeObserver).not.toBeNull();

    const initialObserver = activeObserver;
    await act(async () => {
      activeObserver?.trigger();
    });
    await harness.flush();

    expect(harness.container.querySelectorAll("[data-mobile-card]")).toHaveLength(32);
    expect(list?.getAttribute("data-mobile-work-rendered")).toBe("32");
    expect(activeObserver).not.toBe(initialObserver);

    const secondObserver = activeObserver;
    await act(async () => {
      activeObserver?.trigger();
    });
    await harness.flush();

    expect(harness.container.querySelectorAll("[data-mobile-card]")).toHaveLength(48);
    expect(list?.getAttribute("data-mobile-work-rendered")).toBe("48");
    expect(activeObserver).not.toBe(secondObserver);

    await act(async () => {
      activeObserver?.trigger();
    });
    await harness.flush();

    expect(harness.container.querySelectorAll("[data-mobile-card]")).toHaveLength(50);
    expect(list?.getAttribute("data-mobile-work-rendered")).toBe("50");
    expect(harness.container.querySelector("[data-mobile-work-render-sentinel]")).toBeNull();
  });

  it("keeps explicit network paging available when a local search has no first-page match", async () => {
    meChatMocks.listMeChats
      .mockResolvedValueOnce({
        rows: [chatRow({ chatId: "page-1", title: "First page only" })],
        priorityRows: { pinned: [] },
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        rows: [chatRow({ chatId: "page-2", title: "Needle on later page" })],
        priorityRows: { pinned: [] },
        nextCursor: null,
      });

    renderWithClient(harness, <MobileWorkPage />, "/m/chat");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("First page only"));

    const searchToggle = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Search Chat"]');
    await act(async () => searchToggle?.click());
    const searchInput = harness.container.querySelector<HTMLInputElement>('input[aria-label="Search chats"]');
    if (!searchInput) throw new Error("Missing search input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(searchInput, "Needle");
      searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: "Needle", inputType: "insertText" }));
    });

    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("No matching chats"));
    expect(harness.container.querySelector("[data-mobile-work-render-sentinel]")).toBeNull();
    const loadMore = [...harness.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Load more",
    );
    expect(loadMore).toBeDefined();

    await act(async () => loadMore?.click());
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Needle on later page"));
    expect(meChatMocks.listMeChats).toHaveBeenCalledTimes(2);
  });
});
