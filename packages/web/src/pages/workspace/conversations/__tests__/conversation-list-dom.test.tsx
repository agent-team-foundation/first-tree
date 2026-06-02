// @vitest-environment happy-dom

import type { ChatSource, MeChatRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationList, DRAFT_CHAT_ID } from "../index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
  markMeChatUnread: vi.fn(),
}));

const chatMocks = vi.hoisted(() => ({
  patchChatEngagement: vi.fn(),
}));

vi.mock("../../../../api/me-chats.js", () => meChatMocks);
vi.mock("../../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/chats.js")>()),
  patchChatEngagement: chatMocks.patchChatEngagement,
}));
vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ agentId: "human-agent-self" }),
}));
vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => {
    if (id === "agent-1") return "Kael";
    if (id === "agent-2") return "Design Critique";
    return id ?? "unknown";
  },
}));

let root: Root | null = null;

function participant(agentId: string, displayName: string, type = "agent"): MeChatRow["participants"][number] {
  return {
    agentId,
    displayName,
    type,
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

function row(overrides: Partial<MeChatRow> & { chatId: string; title: string }): MeChatRow {
  return {
    chatId: overrides.chatId,
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title,
    topic: overrides.topic ?? overrides.title,
    participants: overrides.participants ?? [
      participant("human-agent-self", "Gandy", "human"),
      participant("agent-1", "Kael"),
      participant("agent-2", "Design Critique"),
    ],
    participantCount: overrides.participantCount ?? 3,
    lastMessageAt: overrides.lastMessageAt ?? "2026-05-28T11:59:00.000Z",
    lastMessagePreview: overrides.lastMessagePreview ?? `Preview for ${overrides.title}`,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
  };
}

const BASE_ROWS: MeChatRow[] = [
  row({
    chatId: "chat-failed",
    title: "Broken deploy",
    failedAgentIds: ["agent-1"],
    unreadMentionCount: 3,
    chatHasExplicitMentionToMe: true,
  }),
  row({
    chatId: "chat-needs",
    title: "Waiting approval",
    unreadMentionCount: 1,
    chatHasExplicitMentionToMe: true,
    lastMessageAt: null,
    lastMessagePreview: null,
  }),
  row({
    chatId: "chat-manual",
    title: "Manual planning",
    lastMessageAt: "2026-05-28T11:45:00.000Z",
    lastMessagePreview: "Manual planning",
  }),
  row({
    chatId: "chat-github",
    title: "PR review",
    source: "github",
    entityType: "pull_request",
    membershipKind: "watching",
    lastMessageAt: "2026-05-27T10:00:00.000Z",
    lastMessagePreview: "Needs another pass",
  }),
  row({
    chatId: "chat-busy",
    title: "Busy task",
    busyAgentIds: ["agent-1"],
    lastMessageAt: "2026-05-28T10:00:00.000Z",
  }),
];

function createClient(rows = BASE_ROWS, nextCursor: string | null = "cursor-1"): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(["me", "chats", "all", "active", false, null, null], { rows, nextCursor });
  queryClient.setQueryData(["me", "chats", "unread", "active", false, "manual,github", "agent-1"], {
    rows: [],
    nextCursor: null,
  });
  queryClient.setQueryData(["me", "chats", "all", "archived", false, null, null], {
    rows: [row({ chatId: "chat-archived", title: "Archived review", engagementStatus: "archived" })],
    nextCursor: null,
  });
  return queryClient;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement, queryClient = createClient()): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(rootNode: ParentNode, text: string): HTMLButtonElement {
  const button = [...rootNode.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function rowButton(rootNode: ParentNode, title: string): HTMLButtonElement {
  const button = [...rootNode.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!button) throw new Error(`Missing row ${title}`);
  return button;
}

function StatefulList({
  rows = BASE_ROWS,
  nextCursor = "cursor-1",
  selectedChatId = "chat-manual",
  onSelectChat = vi.fn(),
  onNewChat = vi.fn(),
}: {
  rows?: MeChatRow[];
  nextCursor?: string | null;
  selectedChatId?: string | null;
  onSelectChat?: (chatId: string) => void;
  onNewChat?: () => void;
}) {
  void rows;
  void nextCursor;
  const [engagement, setEngagement] = useState<"active" | "archived" | "all">("active");
  const [unread, setUnread] = useState(false);
  const [watching, setWatching] = useState(false);
  const [origin, setOrigin] = useState<ChatSource[]>([]);
  const [participants, setParticipants] = useState<string[]>([]);
  const [group, setGroup] = useState<"recency" | "source">("source");
  return (
    <ConversationList
      selectedChatId={selectedChatId}
      onSelectChat={onSelectChat}
      onNewChat={onNewChat}
      engagement={engagement}
      onEngagementChange={setEngagement}
      unread={unread}
      watching={watching}
      onRailFilterChange={(next) => {
        setUnread(next === "unread");
        setWatching(next === "watching");
      }}
      origin={origin}
      onOriginChange={(next) => setOrigin([...next])}
      participants={participants}
      onParticipantsChange={(next) => setParticipants([...next])}
      onClearFilters={() => {
        setUnread(false);
        setWatching(false);
        setOrigin([]);
        setParticipants([]);
      }}
      group={group}
      onGroupChange={setGroup}
      width={360}
    />
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  meChatMocks.listMeChats.mockReset();
  meChatMocks.markMeChatUnread.mockReset();
  chatMocks.patchChatEngagement.mockReset();
  meChatMocks.listMeChats.mockImplementation(
    async (params?: { cursor?: string; engagement?: string; filter?: string }) => {
      if (params?.cursor) {
        return {
          rows: [row({ chatId: "chat-more", title: "Loaded more", busyAgentIds: ["agent-1"] })],
          nextCursor: null,
        };
      }
      if (params?.engagement === "archived") {
        return {
          rows: [row({ chatId: "chat-archived", title: "Archived review", engagementStatus: "archived" })],
          nextCursor: null,
        };
      }
      if (params?.filter === "unread") {
        return { rows: [], nextCursor: null };
      }
      return { rows: BASE_ROWS, nextCursor: null };
    },
  );
  meChatMocks.markMeChatUnread.mockResolvedValue({ chatId: "chat-manual", unreadMentionCount: 1 });
  chatMocks.patchChatEngagement.mockResolvedValue({ chatId: "chat-manual", engagementStatus: "archived" });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ConversationList", () => {
  it("renders rows, filters, grouping, load-more, row actions, and empty recovery", async () => {
    const onSelectChat = vi.fn();
    const onNewChat = vi.fn();
    const container = await renderDom(<StatefulList onSelectChat={onSelectChat} onNewChat={onNewChat} />);

    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Broken deploy");
    expect(container.textContent).toContain("Waiting approval");
    expect(container.textContent).toContain("Manual");
    expect(container.textContent).toContain("GITHUB");
    expect(container.querySelector('[aria-label="watching"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="failed, 3 unread"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="1 unread"]')).toBeTruthy();

    await click(rowButton(container, "Manual planning"));
    expect(onSelectChat).toHaveBeenCalledWith("chat-manual");

    await click(buttonByText(container, "New chat"));
    expect(onNewChat).toHaveBeenCalledTimes(1);

    await click(buttonByText(container, "Load more"));
    expect(meChatMocks.listMeChats).toHaveBeenCalledWith({
      filter: "all",
      engagement: "active",
      watching: undefined,
      origin: undefined,
      with: undefined,
      cursor: "cursor-1",
    });
    expect(container.textContent).toContain("Loaded more");

    await click(container.querySelector('button[aria-label="Manage chat"]'));
    const markUnread = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Mark as unread",
    ) as HTMLButtonElement | undefined;
    expect(markUnread?.disabled).toBe(true);
    await click(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Archive") ?? null,
    );
    expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith("chat-failed", "archived");

    await click(container.querySelector('button[aria-label="Filter"]'));
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("Manual")) ?? null,
    );
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("GitHub")) ?? null,
    );
    expect(container.textContent).toContain("Filters");
    expect(container.textContent).toContain("Manual");
    expect(container.textContent).toContain("GitHub");

    await click(buttonByText(container, "Unread"));
    await flush();
    expect(meChatMocks.listMeChats).toHaveBeenCalledWith({
      filter: "unread",
      engagement: "active",
      watching: undefined,
      origin: ["manual", "github"],
      with: undefined,
    });

    await click(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Reset all") ?? null,
    );
    expect(container.textContent).not.toContain("Filters");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);

    await click(container.querySelector('button[aria-haspopup="listbox"]'));
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Time") ?? null);
    expect(container.textContent).toContain("Older");

    await click(container.querySelector('button[aria-label="Filter"]'));
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("Archived")) ?? null,
    );
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("Active")) ?? null,
    );
    await flush();
    expect(meChatMocks.listMeChats).toHaveBeenCalledWith({
      filter: "all",
      engagement: "archived",
      watching: undefined,
      origin: undefined,
      with: undefined,
    });
    expect(container.textContent).toContain("Older");
  });

  it("shows loading, empty, error, and draft-selected states", async () => {
    const loadingClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
    });
    meChatMocks.listMeChats.mockImplementation(() => new Promise(() => undefined));
    const loading = await renderDom(<StatefulList rows={[]} nextCursor={null} />, loadingClient);
    expect(loading.textContent).toContain("Loading");
    await act(async () => root?.unmount());
    root = null;

    const emptyClient = createClient([], null);
    const empty = await renderDom(<StatefulList rows={[]} nextCursor={null} />, emptyClient);
    expect(empty.textContent).toContain("No conversations yet.");
    expect(empty.textContent).toContain("Start with New chat.");
    await act(async () => root?.unmount());
    root = null;

    meChatMocks.listMeChats.mockRejectedValueOnce(new Error("cursor expired"));
    const error = await renderDom(<StatefulList />);
    await click(buttonByText(error, "Load more"));
    expect(error.textContent).toContain("cursor expired");
    await act(async () => root?.unmount());
    root = null;

    const draft = await renderDom(<StatefulList selectedChatId={DRAFT_CHAT_ID} nextCursor={null} />);
    expect(buttonByText(draft, "New chat").getAttribute("aria-current")).toBe("page");
  });
});
