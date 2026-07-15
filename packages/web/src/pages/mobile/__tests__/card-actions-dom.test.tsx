// @vitest-environment happy-dom

import type { ChatDetail, ListMeChatsResponse, MeChatRow, Message } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui/toast.js";
import { createDomHarness, type DomHarness, setViewportSize } from "../../../test-utils/dom-harness.js";
import { MobileChatPage } from "../chat.js";
import { MobileNowPage } from "../now.js";

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  listChatOpenRequests: vi.fn(),
  readFileAsBase64: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => ({ agentId: "human-agent-self" }) }));
vi.mock("../../../api/me-chats.js", () => meChatMocks);
vi.mock("../../../api/chats.js", () => chatMocks);

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
function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  return null;
}

function renderPage(harness: DomHarness, page: "now" | "chat"): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(["chat-open-requests", row.chatId], { items: [request] });
  queryClient.setQueryData(["chat-detail", row.chatId], detail);
  queryClient.setQueryData(
    page === "now" ? ["me", "chats", "mobile", "now"] : ["me", "chats", "mobile", "chats", "all"],
    listResponse,
  );
  harness.render(
    <MemoryRouter initialEntries={[`/m/${page}`]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <LocationProbe />
          <Routes>
            <Route path="/m/now" element={<MobileNowPage />} />
            <Route path="/m/chat" element={<MobileChatPage />} />
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

describe("mobile card behavior", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    setViewportSize(390, 844);
    currentLocation = "";
    for (const mock of Object.values(meChatMocks)) mock.mockReset();
    for (const mock of Object.values(chatMocks)) mock.mockReset();
    listResponse = {
      rows: [row],
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    };
    meChatMocks.listMeChats.mockResolvedValue(listResponse);
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [request] });
    chatMocks.getChat.mockResolvedValue(detail);
    chatMocks.sendChatMessage.mockResolvedValue({ ...request, id: "answer-1", format: "text", content: "Ship now" });
    chatMocks.sendFileMessageBatch.mockResolvedValue({ ...request, id: "answer-file-1", format: "file" });
  });

  afterEach(() => harness.cleanup());

  it("keeps Now cards free of management menus and swipe actions", async () => {
    renderPage(harness, "now");
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    const card = harness.container.querySelector<HTMLElement>('[data-mobile-card="feed"]');
    expect(card?.querySelector("[data-mobile-card-menu]")).toBeNull();
    expect(harness.container.querySelector("[data-mobile-swipe-surface]")).toBeNull();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps Chat rows as direct detail links without Now actions or swipe wrappers", async () => {
    listResponse = {
      rows: [],
      priorityRows: { attention: [row], pinned: [] },
      nextCursor: null,
    };
    renderPage(harness, "chat");
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    const card = harness.container.querySelector<HTMLElement>('[data-mobile-card="list"]');
    expect(card?.tagName).toBe("BUTTON");
    expect(card?.getAttribute("style")).toContain("min-height: calc(var(--sp-16) + var(--sp-6))");
    expect(card?.querySelector("[data-mobile-card-menu]")).toBeNull();
    expect(harness.container.querySelector("[data-mobile-swipe-surface]")).toBeNull();
  });

  it("opens the question over Now, sends the answer, and never navigates into detail", async () => {
    const queryClient = renderPage(harness, "now");
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    await click(harness.container.querySelector("[data-mobile-primary-action]"));
    await harness.waitFor(() =>
      expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
        "Question from gandy-coder",
      ),
    );
    expect(currentLocation).toBe("/m/now");
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
    expect(currentLocation).toBe("/m/now");
    await harness.waitFor(() => expect(document.body.querySelector("[data-mobile-ask-sheet]")).toBeNull());
    await harness.waitFor(() => expect(harness.container.textContent).not.toContain(row.title));

    // Simulate delayed stale projections arriving after the sheet closed. The
    // row may briefly expose Answer again, but the request-id tombstone keeps
    // the resolved request inert and prevents a second transport submission.
    queryClient.setQueryData(["chat-open-requests", row.chatId], { items: [request] });
    queryClient.setQueryData<ListMeChatsResponse>(["me", "chats", "mobile", "now"], {
      rows: [row],
      priorityRows: { attention: [row], pinned: [] },
      nextCursor: null,
    });
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    await click(harness.container.querySelector("[data-mobile-primary-action]"));
    await harness.waitFor(() =>
      expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Question unavailable"),
    );
    expect(document.body.textContent).toContain("Question already handled");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("lets the feed sheet close without resolving the question", async () => {
    renderPage(harness, "now");
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    await click(harness.container.querySelector("[data-mobile-primary-action]"));
    await harness.waitFor(() => expect(document.body.querySelector('[aria-label="Close question"]')).not.toBeNull());

    await click(document.body.querySelector('[aria-label="Close question"]'));
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-mobile-ask-sheet]")).toBeNull();
    expect(currentLocation).toBe("/m/now");
  });
});
