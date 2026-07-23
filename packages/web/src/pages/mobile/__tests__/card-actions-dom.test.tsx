// @vitest-environment happy-dom

import type { ChatDetail, ListMeChatsResponse, MeChatRow, Message } from "@first-tree/shared";
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
  markMeChatRead: vi.fn(),
  markMeChatUnread: vi.fn(),
  pinMeChat: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  listChatOpenRequests: vi.fn(),
  readFileAsBase64: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
  patchChatEngagement: vi.fn(),
}));
const gitlabMocks = vi.hoisted(() => ({ listGitlabConnectionsAt: vi.fn() }));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ agentId: "human-agent-self", organizationId: "org-1" }),
}));
vi.mock("../../../api/me-chats.js", () => meChatMocks);
vi.mock("../../../api/chats.js", () => chatMocks);
vi.mock("../../../api/gitlab-connections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/gitlab-connections.js")>()),
  listGitlabConnectionsAt: gitlabMocks.listGitlabConnectionsAt,
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

const request: Message = {
  id: "request-1",
  chatId: row.chatId,
  senderId: "agent-1",
  format: "request",
  content: "## Release decision\n\nThe staging evidence is green. Which rollout should we use?",
  metadata: {
    mentions: ["human-agent-self"],
    request: {
      multiSelect: false,
      options: [
        { label: "Ship now", description: "Start the production rollout." },
        { label: "Hold", description: "Keep the release on staging." },
      ],
    },
  },
  inReplyTo: null,
  source: "web",
  createdAt: "2026-07-14T10:00:00.000Z",
};

const detail: ChatDetail = {
  id: row.chatId,
  organizationId: "org-1",
  type: "group",
  topic: row.topic,
  description: row.description,
  lifecyclePolicy: null,
  metadata: {},
  createdAt: "2026-07-14T09:00:00.000Z",
  updatedAt: "2026-07-14T10:00:00.000Z",
  title: row.title,
  firstMessagePreview: "Release decision",
  engagementStatus: "active",
  viewerMembershipKind: "participant",
  descriptionUpdatedAt: null,
  lastReadAt: null,
  participants: [
    {
      agentId: "human-agent-self",
      role: "member",
      mode: "full",
      joinedAt: "2026-07-14T09:00:00.000Z",
      name: "gandy2025",
      displayName: "Gandy",
      type: "human",
      avatarColorToken: null,
      avatarImageUrl: null,
    },
    {
      agentId: "agent-1",
      role: "member",
      mode: "full",
      joinedAt: "2026-07-14T09:00:00.000Z",
      name: "gandy-coder",
      displayName: "gandy-coder",
      type: "agent",
      avatarColorToken: null,
      avatarImageUrl: null,
    },
  ],
};

let currentLocation = "";
let listResponse: ListMeChatsResponse;
let queryClients: QueryClient[] = [];
function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  return null;
}

function renderPage(harness: DomHarness): QueryClient {
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
  queryClient.setQueryData(["chat-open-requests", row.chatId], { items: [request] });
  queryClient.setQueryData(["chat-detail", row.chatId], detail);
  meChatMocks.listMeChats.mockResolvedValue(listResponse);
  harness.render(
    <MemoryRouter initialEntries={["/m/work"]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <LocationProbe />
          <Routes>
            <Route path="/m/work" element={<MobileWorkPage />} />
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

describe("mobile card behavior", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    setViewportSize(390, 844);
    currentLocation = "";
    queryClients = [];
    for (const mock of Object.values(meChatMocks)) mock.mockReset();
    for (const mock of Object.values(chatMocks)) mock.mockReset();
    gitlabMocks.listGitlabConnectionsAt.mockReset();
    listResponse = {
      rows: [row],
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    };
    meChatMocks.listMeChats.mockResolvedValue(listResponse);
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [request] });
    chatMocks.getChat.mockResolvedValue(detail);
    gitlabMocks.listGitlabConnectionsAt.mockResolvedValue([]);
    chatMocks.sendChatMessage.mockResolvedValue({ ...request, id: "answer-1", format: "text", content: "Ship now" });
    chatMocks.sendFileMessageBatch.mockResolvedValue({ ...request, id: "answer-file-1", format: "file" });
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

  it("keeps action cards free of visible overflow and swipe actions", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    const card = harness.container.querySelector<HTMLElement>('[data-mobile-card="action"]');
    const longPressTarget = card?.querySelector<HTMLElement>("button");
    expect(card?.querySelector("[data-mobile-card-menu]")).toBeNull();
    expect(harness.container.querySelector("[data-mobile-swipe-surface]")).toBeNull();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(longPressTarget?.style.userSelect).toBe("none");
    expect(Reflect.get(longPressTarget?.style ?? {}, "WebkitUserSelect")).toBe("none");
    expect(Reflect.get(longPressTarget?.style ?? {}, "WebkitTouchCallout")).toBe("none");
    expect(card?.querySelector('[aria-haspopup="dialog"]')?.getAttribute("aria-description")).toBe(
      "Long press for chat actions",
    );
  });

  it("keeps regular Work rows as direct detail buttons without visible overflow or swipe wrappers", async () => {
    const settled = { ...row, openRequestCount: 0 };
    listResponse = {
      rows: [settled],
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    };
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    const card = harness.container.querySelector<HTMLElement>('[data-mobile-card="work"]');
    expect(card?.tagName).toBe("BUTTON");
    expect(card?.getAttribute("style")).toContain("min-height: calc(var(--sp-20) + var(--sp-8))");
    expect(card?.querySelector("[data-mobile-card-menu]")).toBeNull();
    expect(harness.container.querySelector("[data-mobile-swipe-surface]")).toBeNull();
    expect(card?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(card?.style.userSelect).toBe("none");
    expect(Reflect.get(card?.style ?? {}, "WebkitUserSelect")).toBe("none");
    expect(Reflect.get(card?.style ?? {}, "WebkitTouchCallout")).toBe("none");
    expect(card?.style.touchAction).toBe("pan-y");
  });

  it("opens contextual triage on an action-card long press and blocks archive while judgment is unresolved", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    const selection = window.getSelection();
    if (!selection) throw new Error("Missing document selection");
    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");

    await longPress(harness.container.querySelector('[data-mobile-card="action"] > button'));

    expect(currentLocation).toBe("/m/work");
    expect(removeAllRanges).toHaveBeenCalledOnce();
    removeAllRanges.mockRestore();
    const actionsSheet = document.body.querySelector("[data-mobile-chat-actions]");
    expect(actionsSheet).not.toBeNull();
    expect(actionsSheet?.getAttribute("aria-label")).toBe(`Actions for ${row.title}`);
    expect(actionsSheet?.getAttribute("aria-labelledby")).toBeNull();
    expect(actionsSheet?.textContent).not.toContain("Chat actions");
    expect(actionsSheet?.textContent).not.toContain(row.title);
    expect(buttonWithText("Pin")).not.toBeNull();
    expect(buttonWithText("Mark as unread")).not.toBeNull();
    expect(buttonWithText("Archive")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Answer or skip the open question before archiving.");
    expect(buttonWithText("Delete")).toBeNull();
  });

  it("cancels long press after movement and preserves the card's normal click", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const card = harness.container.querySelector('[data-mobile-card="action"] > button');

    await longPress(card, 12);
    expect(document.body.querySelector("[data-mobile-chat-actions]")).toBeNull();

    await click(card);
    expect(currentLocation).toBe(`/m/work?c=${row.chatId}`);
  });

  it("opens Chat actions from the keyboard and archives only a settled chat with Undo", async () => {
    const settled = { ...row, openRequestCount: 0 };
    listResponse = { rows: [settled], priorityRows: { attention: [], pinned: [] }, nextCursor: null };
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const card = harness.container.querySelector('[data-mobile-card="work"]');

    await act(async () => {
      card?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F10", shiftKey: true }),
      );
    });
    expect(document.body.querySelector("[data-mobile-chat-actions]")).not.toBeNull();
    expect(buttonWithText("Archive")?.disabled).toBe(false);

    await click(buttonWithText("Archive"));
    await harness.waitFor(() => expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith(row.chatId, "archived"));
    expect(document.body.querySelector("[data-mobile-chat-actions]")).toBeNull();
    await harness.waitFor(() => expect(buttonWithText("Undo")).not.toBeNull());

    await click(buttonWithText("Undo"));
    await harness.waitFor(() => expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith(row.chatId, "active"));
  });

  it("offers the inverse read action through the non-touch context-menu path", async () => {
    const unread = { ...row, openRequestCount: 0, unreadMentionCount: 2 };
    listResponse = { rows: [unread], priorityRows: { attention: [], pinned: [] }, nextCursor: null };
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const card = harness.container.querySelector('[data-mobile-card="work"]');

    await act(async () => {
      card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    });
    expect(buttonWithText("Mark as read")).not.toBeNull();
    await click(buttonWithText("Mark as read"));

    await harness.waitFor(() => expect(meChatMocks.markMeChatRead).toHaveBeenCalledWith(row.chatId));
    expect(currentLocation).toBe("/m/work");
  });

  it("provides an Archived recovery view whose long-press actions only restore or pin", async () => {
    const archived = { ...row, openRequestCount: 0, engagementStatus: "archived" as const };
    listResponse = { rows: [archived], priorityRows: { attention: [], pinned: [] }, nextCursor: null };
    meChatMocks.listMeChats.mockResolvedValue(listResponse);
    renderPage(harness);

    await click(harness.container.querySelector('button[aria-label="Filter Work"]'));
    await click(buttonWithText("Archived"));
    await harness.waitFor(() =>
      expect(meChatMocks.listMeChats).toHaveBeenCalledWith(
        expect.objectContaining({ engagement: "archived" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const card = harness.container.querySelector('[data-mobile-card="work"]');
    await longPress(card);

    expect(buttonWithText("Unarchive")).not.toBeNull();
    expect(buttonWithText("Pin")).not.toBeNull();
    expect(buttonWithText("Archive")).toBeNull();
    expect(buttonWithText("Mark as unread")).toBeNull();

    await click(buttonWithText("Unarchive"));
    await harness.waitFor(() => expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith(row.chatId, "active"));
  });

  it("uses the watching dimension for both the Work rows and unread-count projection", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    await click(harness.container.querySelector('button[aria-label="Filter Work"]'));
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

  it("opens the question over Work, sends the answer, and never navigates into detail", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    await click(harness.container.querySelector("[data-mobile-primary-action]"));
    await harness.waitFor(() =>
      expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
        "Question from gandy-coder",
      ),
    );
    expect(currentLocation).toBe("/m/work");
    expect(document.body.textContent).toContain("Which rollout should we use?");

    await click(
      [...document.body.querySelectorAll('button[role="radio"]')].find((item) =>
        item.textContent?.includes("Ship now"),
      ) ?? null,
    );
    await click([...document.body.querySelectorAll("button")].find((item) => item.textContent === "Reply") ?? null);

    await harness.waitFor(() =>
      expect(chatMocks.sendChatMessage).toHaveBeenCalledWith(row.chatId, "Ship now", ["agent-1"], {
        inReplyTo: request.id,
        resolves: { request: request.id, kind: "answered" },
      }),
    );
    expect(currentLocation).toBe("/m/work");
    await harness.waitFor(() =>
      expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Question unavailable"),
    );
    await click(document.body.querySelector('[aria-label="Close question"]'));
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    expect(harness.container.querySelector("[data-mobile-primary-action]")).toBeNull();
    expect(chatMocks.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("compacts trusted bare GitLab links in the Mobile Now ask sheet", async () => {
    const canonical = "https://gitlab.internal/acme/web/-/merge_requests/42";
    const customLabel = `[Review the MR](${canonical})`;
    const queryClient = renderPage(harness);
    queryClient.setQueryData(["chat-open-requests", row.chatId], {
      items: [{ ...request, content: [canonical, customLabel].join("\n\n") }],
    });
    queryClient.setQueryData(
      ["gitlab-connections", detail.organizationId],
      [{ instanceOrigin: "https://gitlab.internal" }],
    );

    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    await click(harness.container.querySelector("[data-mobile-primary-action]"));
    await harness.waitFor(() => expect(document.body.querySelector('[role="dialog"] a')).not.toBeNull());

    const anchors = [...document.body.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')];
    const compact = anchors.find((anchor) => anchor.textContent === "acme/web!42");
    expect(compact?.getAttribute("href")).toBe(canonical);
    expect(compact?.title).toBe(canonical);
    expect(anchors.find((anchor) => anchor.textContent === "Review the MR")?.getAttribute("href")).toBe(canonical);
  });

  it("lets the feed sheet close without resolving the question", async () => {
    renderPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    await click(harness.container.querySelector("[data-mobile-primary-action]"));
    await harness.waitFor(() => expect(document.body.querySelector('[aria-label="Close question"]')).not.toBeNull());

    await click(document.body.querySelector('[aria-label="Close question"]'));
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-mobile-ask-sheet]")).toBeNull();
    expect(currentLocation).toBe("/m/work");
  });
});
