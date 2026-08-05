// @vitest-environment happy-dom

import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui/toast.js";
import { createDomHarness, type DomHarness, setViewportSize } from "../../../test-utils/dom-harness.js";
import { MobileWorkPage } from "../work.js";

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
  listMeChatSourceCounts: vi.fn(),
  listNeedYouRequests: vi.fn(),
  markMeChatRead: vi.fn(),
  markMeChatUnread: vi.fn(),
  pinMeChat: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  patchChatEngagement: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ agentId: "human-agent-self", organizationId: "org-1" }),
}));
vi.mock("../../../api/me-chats.js", () => meChatMocks);
vi.mock("../../../api/chats.js", () => chatMocks);
vi.mock("../../workspace/center/index.js", () => ({
  CenterPanel: () => <div data-testid="mobile-chat-detail">Chat detail</div>,
}));

const row: MeChatRow = {
  chatId: "question",
  type: "group",
  membershipKind: "participant",
  createdByMe: false,
  source: "manual",
  entityType: null,
  title: "Release readiness",
  topic: "Release readiness",
  description: "Choose the release path after checking the evidence.",
  participants: [
    {
      agentId: "human-agent-self",
      displayName: "Gandy",
      type: "human",
      avatarColorToken: null,
      avatarImageUrl: null,
    },
    {
      agentId: "agent-1",
      displayName: "gandy-coder",
      type: "agent",
      avatarColorToken: null,
      avatarImageUrl: null,
    },
  ],
  participantCount: 2,
  lastMessageAt: "2026-07-14T10:00:00.000Z",
  lastMessagePreview: "Which rollout should we use?",
  unreadMentionCount: 0,
  openRequestCount: 1,
  canReply: true,
  engagementStatus: "active",
  liveActivity: null,
  failedAgentIds: [],
  busyAgentIds: [],
  chatHasExplicitMentionToMe: false,
  pinnedAt: null,
  activityAt: "2026-07-14T10:00:00.000Z",
};

let currentLocation = "";
let listResponse: ListMeChatsResponse;
let queryClients: QueryClient[] = [];

function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  return null;
}

function renderPage(harness: DomHarness, needYouCount = 1): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClients.push(queryClient);
  queryClient.setQueryData(["me", "chats", "mobile", "work-list", "org-1", "active", false, "all"], {
    pages: [listResponse],
    pageParams: [undefined],
  });
  queryClient.setQueryData(["me", "chats", "mobile", "work-source-counts", "org-1", "active", false], {
    counts: {},
  });
  queryClient.setQueryData(["need-you", "org-1"], {
    items:
      needYouCount > 0
        ? [{ request: { id: "req-oldest" }, chat: { id: "question", title: "Question" }, asker: { agentId: "a-1" } }]
        : [],
    total: needYouCount,
    nextCursor: null,
  });
  meChatMocks.listMeChats.mockResolvedValue(listResponse);
  harness.render(
    <MemoryRouter initialEntries={["/m/chat"]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <LocationProbe />
          <Routes>
            <Route path="/m/chat" element={<MobileWorkPage />} />
          </Routes>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return queryClient;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Missing click target");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function longPress(element: Element | null, moveBy = 0): Promise<void> {
  if (!element) throw new Error("Missing long-press target");
  vi.useFakeTimers();
  try {
    await act(async () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 20 }),
      );
      if (moveBy > 0) {
        element.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 20 + moveBy,
            clientY: 20,
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(500);
    });
  } finally {
    vi.useRealTimers();
  }
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

describe("mobile Chat card behavior", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    setViewportSize(390, 844);
    currentLocation = "";
    queryClients = [];
    for (const mock of Object.values(meChatMocks)) mock.mockReset();
    for (const mock of Object.values(chatMocks)) mock.mockReset();
    listResponse = {
      rows: [row],
      priorityRows: { pinned: [] },
      nextCursor: null,
    };
    meChatMocks.listMeChats.mockResolvedValue(listResponse);
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
    meChatMocks.listNeedYouRequests.mockResolvedValue({ items: [], total: 1, nextCursor: null });
    chatMocks.patchChatEngagement.mockImplementation(async (chatId: string, engagementStatus: string) => ({
      chatId,
      engagementStatus,
    }));
    meChatMocks.markMeChatRead.mockResolvedValue({ chatId: row.chatId, unreadMentionCount: 0 });
    meChatMocks.markMeChatUnread.mockResolvedValue({ chatId: row.chatId, unreadMentionCount: 1 });
    meChatMocks.pinMeChat.mockResolvedValue({ chatId: row.chatId, pinnedAt: "2026-07-18T00:00:00.000Z" });
  });

  afterEach(() => {
    harness.cleanup();
    for (const queryClient of queryClients) queryClient.clear();
  });

  it("keeps ask chats as ordinary detail rows with status encoded on the avatar", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    const card = harness.container.querySelector<HTMLElement>('[data-mobile-card="work"]');
    expect(card?.tagName).toBe("BUTTON");
    expect(harness.container.querySelector('[data-mobile-card="action"]')).toBeNull();
    expect(harness.container.querySelector("[data-mobile-primary-action]")).toBeNull();
    expect(card?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(card?.getAttribute("aria-description")).toBe("Long press for chat actions");
    expect(card?.style.userSelect).toBe("none");
    expect(Reflect.get(card?.style ?? {}, "WebkitUserSelect")).toBe("none");
    expect(Reflect.get(card?.style ?? {}, "WebkitTouchCallout")).toBe("none");
    expect(card?.style.touchAction).toBe("pan-y");
  });

  it("opens contextual actions on long press and blocks archive while an ask is unresolved", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    const selection = window.getSelection();
    if (!selection) throw new Error("Missing document selection");
    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
    await longPress(harness.container.querySelector('[data-mobile-card="work"]'));

    expect(currentLocation).toBe("/m/chat");
    expect(removeAllRanges).toHaveBeenCalledOnce();
    removeAllRanges.mockRestore();
    const actionsSheet = document.body.querySelector("[data-mobile-chat-actions]");
    expect(actionsSheet).not.toBeNull();
    expect(buttonWithText("Pin")).not.toBeNull();
    expect(buttonWithText("Mark as unread")).not.toBeNull();
    expect(buttonWithText("Archive")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Answer or skip the open question before archiving.");
  });

  it("cancels long press after movement and preserves the row's normal Chat navigation", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const card = harness.container.querySelector('[data-mobile-card="work"]');

    await longPress(card, 12);
    expect(document.body.querySelector("[data-mobile-chat-actions]")).toBeNull();
    await click(card);
    expect(currentLocation).toBe(`/m/chat?c=${row.chatId}`);
    expect(harness.container.querySelector('[data-testid="mobile-chat-detail"]')).not.toBeNull();
  });

  it("opens Chat actions from the keyboard and archives only a settled chat with Undo", async () => {
    const settled = { ...row, openRequestCount: 0 };
    listResponse = { rows: [settled], priorityRows: { pinned: [] }, nextCursor: null };
    const queryClient = renderPage(harness);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const card = harness.container.querySelector('[data-mobile-card="work"]');

    await act(async () => {
      card?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F10", shiftKey: true }),
      );
    });
    expect(buttonWithText("Archive")?.disabled).toBe(false);
    await click(buttonWithText("Archive"));
    await harness.waitFor(() => expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith(row.chatId, "archived"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["need-you"] });
    await harness.waitFor(() => expect(buttonWithText("Undo")).not.toBeNull());
    await click(buttonWithText("Undo"));
    await harness.waitFor(() => expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith(row.chatId, "active"));
    expect(invalidateSpy.mock.calls.filter(([options]) => options?.queryKey?.[0] === "need-you")).toHaveLength(2);
  });

  it("offers the inverse read action through the context-menu path", async () => {
    const unread = { ...row, openRequestCount: 0, unreadMentionCount: 2 };
    listResponse = { rows: [unread], priorityRows: { pinned: [] }, nextCursor: null };
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const card = harness.container.querySelector('[data-mobile-card="work"]');

    await act(async () => {
      card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    });
    await click(buttonWithText("Mark as read"));
    await harness.waitFor(() => expect(meChatMocks.markMeChatRead).toHaveBeenCalledWith(row.chatId));
    expect(currentLocation).toBe("/m/chat");
  });

  it("provides an Archived recovery view whose actions only restore or pin", async () => {
    const archived = { ...row, openRequestCount: 0, engagementStatus: "archived" as const };
    listResponse = { rows: [archived], priorityRows: { pinned: [] }, nextCursor: null };
    meChatMocks.listMeChats.mockResolvedValue(listResponse);
    renderPage(harness);

    await click(harness.container.querySelector('button[aria-label="Filter Chat"]'));
    await click(buttonWithText("Archived"));
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    await longPress(harness.container.querySelector('[data-mobile-card="work"]'));

    expect(buttonWithText("Unarchive")).not.toBeNull();
    expect(buttonWithText("Pin")).not.toBeNull();
    expect(buttonWithText("Archive")).toBeNull();
    expect(buttonWithText("Mark as unread")).toBeNull();
    await click(buttonWithText("Unarchive"));
    await harness.waitFor(() => expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith(row.chatId, "active"));
  });

  it("uses the watching dimension for both Chat rows and unread counts", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    await click(harness.container.querySelector('button[aria-label="Filter Chat"]'));
    await click(buttonWithText("Watching only"));
    await harness.waitFor(() =>
      expect(meChatMocks.listMeChats).toHaveBeenCalledWith(
        expect.objectContaining({ engagement: "active", filter: "all", watching: true }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await harness.waitFor(() =>
      expect(meChatMocks.listMeChatSourceCounts).toHaveBeenCalledWith(
        { engagement: "active", watching: true },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("opens the oldest request's chat with the queue session when count is nonzero", async () => {
    renderPage(harness);
    await harness.waitFor(() =>
      expect(harness.container.querySelector('button[aria-label="Need you, 1 question"]')).not.toBeNull(),
    );

    await click(harness.container.querySelector('button[aria-label="Need you, 1 question"]'));
    expect(currentLocation).toBe("/m/chat?c=question&nq=1");
    expect(harness.container.querySelector('[data-testid="mobile-chat-detail"]')).not.toBeNull();
  });

  it("disables Need you without rendering a count when the queue is empty", async () => {
    renderPage(harness, 0);
    const entry = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Need you, no questions"]');
    expect(entry?.disabled).toBe(true);
    expect(entry?.textContent).toBe("Need you");
  });
});
