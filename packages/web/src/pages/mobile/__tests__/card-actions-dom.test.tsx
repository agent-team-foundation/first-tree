// @vitest-environment happy-dom

import type { ChatDetail, MeChatRow, Message } from "@first-tree/shared";
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
  markMeChatUnread: vi.fn(),
  pinMeChat: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  listChatOpenRequests: vi.fn(),
  patchChatEngagement: vi.fn(),
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
function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  return null;
}

function renderPage(harness: DomHarness, page: "now" | "chat") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Missing click target");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("mobile card actions", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    setViewportSize(390, 844);
    currentLocation = "";
    for (const mock of Object.values(meChatMocks)) mock.mockReset();
    for (const mock of Object.values(chatMocks)) mock.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [row],
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    });
    meChatMocks.pinMeChat.mockResolvedValue({ chatId: row.chatId, pinnedAt: "2026-07-14T12:00:00.000Z" });
    meChatMocks.markMeChatUnread.mockResolvedValue({ chatId: row.chatId, unreadMentionCount: 1 });
    chatMocks.patchChatEngagement.mockResolvedValue({ chatId: row.chatId, engagementStatus: "archived" });
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [request] });
    chatMocks.getChat.mockResolvedValue(detail);
    chatMocks.sendChatMessage.mockResolvedValue({ ...request, id: "answer-1", format: "text", content: "Ship now" });
    chatMocks.sendFileMessageBatch.mockResolvedValue({ ...request, id: "answer-file-1", format: "file" });
  });

  afterEach(() => harness.cleanup());

  it("offers only the approved reversible triage actions from the card menu", async () => {
    renderPage(harness, "chat");
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));

    await click(harness.container.querySelector(`button[aria-label="Manage ${row.title}"]`));
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Pin chat");
    expect(menu?.textContent).toContain("Mark as unread");
    expect(menu?.textContent).toContain("Archive chat");
    expect(menu?.textContent).not.toContain("Delete");

    await click(
      [...document.body.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "Pin chat") ?? null,
    );
    await harness.waitFor(() => expect(meChatMocks.pinMeChat).toHaveBeenCalledWith(row.chatId, true));
    expect(currentLocation).toBe("/m/chat");
  });

  it("keeps the shortcut tray open after a swipe while suppressing the card click", async () => {
    renderPage(harness, "chat");
    await harness.waitFor(() => expect(harness.container.textContent).toContain(row.title));
    const surface = harness.container.querySelector<HTMLElement>("[data-mobile-swipe-surface]");
    if (!surface) throw new Error("Missing swipe surface");
    surface.setPointerCapture = vi.fn();

    await act(async () => {
      surface.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientX: 320,
          clientY: 200,
        }),
      );
      surface.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientX: 100,
          clientY: 202,
        }),
      );
      surface.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientX: 100,
          clientY: 202,
        }),
      );
      // Browsers emit a synthetic click after pointerup. It must be swallowed
      // without immediately closing the tray the swipe just opened.
      surface.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const translatedX = Number.parseFloat(surface.style.transform.match(/translate3d\(([^,]+)/)?.[1] ?? "0");
    expect(translatedX).toBe(-3 * 68);
    expect(surface.previousElementSibling?.getAttribute("aria-hidden")).toBe("false");
    expect(currentLocation).toBe("/m/chat");
  });

  it("opens the question over Now, sends the answer, and never navigates into detail", async () => {
    renderPage(harness, "now");
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
