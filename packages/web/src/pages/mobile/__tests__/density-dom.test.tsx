// @vitest-environment happy-dom

import type { MeChatRow, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui/toast.js";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileChatPage } from "../chat.js";
import { MobileNowPage } from "../now.js";

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
    pinnedAt: null,
    activityAt: null,
  };
}

function renderWithClient(harness: DomHarness, element: ReactElement, path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Routes>
            <Route path="/m/now" element={element} />
            <Route path="/m/chat" element={element} />
          </Routes>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
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
  });

  it("renders Now work as one priority feed without section grouping", async () => {
    renderWithClient(harness, <MobileNowPage />, "/m/now");
    await harness.waitFor(() => expect(harness.container.textContent).toContain("Release readiness"));
    expect(harness.container.textContent).toContain("Now");
    expect(harness.container.textContent).not.toContain("need attention");

    const sectionHeadings = [...harness.container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(sectionHeadings).not.toContain("Needs attention");
    expect(sectionHeadings).not.toContain("In progress");
    expect(sectionHeadings).not.toContain("Recent");

    const feed = harness.container.querySelector("[data-mobile-feed]");
    if (!feed) throw new Error("Missing Now feed");
    const feedCards = [...feed.querySelectorAll<HTMLElement>('[data-mobile-card="feed"]')];
    // Now is signal-filtered: the `idle` "Recent update" row is dropped, leaving
    // the question (priority) and working (feed) cards.
    expect(feedCards).toHaveLength(2);
    expect(feedCards[0]?.textContent).toContain("Release readiness");
    expect(feedCards[0]?.getAttribute("style")).toContain("min-height: var(--sp-35)");
    expect(feedCards[1]?.getAttribute("style")).toContain("min-height: var(--sp-20)");
    expect(feedCards[0]?.querySelector("[data-mobile-card-title]")?.className).toContain("text-mobile-title");
    expect(feedCards[0]?.querySelector("[data-mobile-card-preview]")?.className).toContain("text-mobile-body");
    const labels = [...feed.querySelectorAll("[data-mobile-signal-label]")].map((label) => label.textContent);
    expect(labels).toEqual(["Needs your answer", "Working now"]);
    expect(feedCards[0]?.querySelector("[data-mobile-signal-label]")?.className).toContain("truncate");
    expect(feedCards[0]?.querySelector("[data-mobile-signal-label]")?.parentElement?.className).toContain(
      "text-mobile-label",
    );
    expect(feedCards[0]?.querySelector("[data-mobile-primary-action]")?.textContent).toContain("Answer");
    expect(feedCards[1]?.querySelector("[data-mobile-primary-action]")).toBeNull();
    expect(feed.querySelector('[data-mobile-card="list"]')).toBeNull();
    expect(harness.container.textContent).not.toContain("Recent update");
  });

  it("renders Chat rows as medium list cards, not full feed cards", async () => {
    renderWithClient(harness, <MobileChatPage />, "/m/chat");
    await harness.waitFor(() => expect(harness.container.textContent).toContain("Release readiness"));

    const listCard = harness.container.querySelector<HTMLElement>('[data-mobile-card="list"]');
    if (!listCard) throw new Error("Missing Chat list card");
    expect(listCard.getAttribute("style")).toContain("min-height: calc(var(--sp-16) + var(--sp-6))");
    expect(listCard.querySelector("[data-mobile-card-title]")?.className).toContain("text-mobile-subtitle");
    expect(listCard.querySelector("[data-mobile-signal-label]")?.parentElement?.className).toContain("mono");
    expect(listCard.querySelector("[data-mobile-card-menu]")).toBeNull();
    expect(harness.container.querySelector("[data-mobile-swipe-surface]")).toBeNull();
    expect(harness.container.querySelector('[data-mobile-card="feed"]')).toBeNull();
  });

  it("renders card previews with inline markdown peeled, not as literal markers", async () => {
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [
        chatRow({
          chatId: "md",
          title: "Markdown preview",
          openRequestCount: 1,
          description: "**Task:** run the seed (`first-tree-seed`)",
        }),
      ],
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    });
    renderWithClient(harness, <MobileNowPage />, "/m/now");
    // React Query notifies observers on a timer; let that task settle inside
    // act before the harness performs its microtask-only DOM polling.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await harness.waitFor(() => expect(harness.container.textContent).toContain("Markdown preview"));

    const preview = harness.container.querySelector("[data-mobile-card-preview]");
    expect(preview?.textContent).toBe("Task: run the seed (first-tree-seed)");
    expect(preview?.textContent).not.toContain("**");
    expect(preview?.textContent).not.toContain("`");
  });
});
