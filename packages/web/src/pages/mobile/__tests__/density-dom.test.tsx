// @vitest-environment happy-dom

import type { MeChatRow, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
            <Route path="/m/work" element={element} />
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
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    });
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
  });

  it("renders one continuous Work feed in Attention then Pinned then Recency order", async () => {
    renderWithClient(harness, <MobileWorkPage />, "/m/work");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Release readiness"));
    expect(harness.container.textContent).toContain("Work");

    const sectionHeadings = [...harness.container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(sectionHeadings).toEqual([]);

    const cards = [...harness.container.querySelectorAll<HTMLElement>("[data-mobile-card]")];
    expect(cards).toHaveLength(3);
    expect(cards[0]?.getAttribute("data-mobile-card")).toBe("action");
    expect(cards[0]?.textContent).toContain("Release readiness");
    expect(cards[0]?.querySelector("[data-mobile-primary-action]")?.textContent).toContain("Answer");
    expect(cards[1]?.getAttribute("data-mobile-card")).toBe("work");
    expect(cards[1]?.textContent).toContain("Context docs");
    expect(cards[2]?.textContent).toContain("Team roster polish");
  });

  it("gives ordinary summaries three lines while keeping dynamic and action evidence compact", async () => {
    renderWithClient(harness, <MobileWorkPage />, "/m/work");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Release readiness"));

    const cards = [...harness.container.querySelectorAll<HTMLElement>("[data-mobile-card]")];
    const actionCard = cards.find((card) => card.textContent?.includes("Release readiness"));
    const workingCard = cards.find((card) => card.textContent?.includes("Context docs"));
    const ordinaryCard = cards.find((card) => card.textContent?.includes("Team roster polish"));
    if (!actionCard || !workingCard || !ordinaryCard) throw new Error("Missing expected Work cards");

    expect(actionCard.querySelector("[data-mobile-card-preview]")?.getAttribute("data-line-clamp")).toBe("2");
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

  it("counts pinned attention rows and unread rows from the same Work projection", async () => {
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
      priorityRows: { attention: [pinnedAttention], pinned: [pinnedQuiet] },
      nextCursor: null,
    });
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({
      counts: { manual: { chatCount: 3, unreadChatCount: 2 } },
    });

    renderWithClient(harness, <MobileWorkPage />, "/m/work");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Pinned urgent work"));

    const chips = [...harness.container.querySelectorAll<HTMLButtonElement>("[data-mobile-work-quick-views] button")];
    expect(chips.find((chip) => chip.textContent?.includes("Need you"))?.textContent).toContain("1");
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
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    });
    renderWithClient(harness, <MobileWorkPage />, "/m/work");
    await waitForSettled(harness, () => expect(harness.container.textContent).toContain("Markdown preview"));

    const preview = harness.container.querySelector("[data-mobile-card-preview]");
    expect(preview?.textContent).toBe("Task: run the seed (first-tree-seed)");
    expect(preview?.textContent).not.toContain("**");
    expect(preview?.textContent).not.toContain("`");
  });
});
