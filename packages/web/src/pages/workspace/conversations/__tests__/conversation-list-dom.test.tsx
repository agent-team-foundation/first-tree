// @vitest-environment happy-dom

import type { ChatSource, ListMeChatsResponse, MeChatPriorityRows, MeChatRow } from "@first-tree/shared";
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
// Rows render RowEngagementMenu, which uses the toast hook; the harness has no
// ToastProvider, so stub it.
vi.mock("../../../../components/ui/toast.js", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
// The filter popover's Participants picker is search-driven (`useOrgAgentsSearch`);
// stub it so the list doesn't hit the network. The list tests never type into the
// participant search, so an empty result is all that's needed.
vi.mock("../../../../lib/use-org-agents.js", () => ({
  useOrgAgentsSearch: () => ({ data: { items: [] }, isFetching: false }),
}));
vi.mock("../../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/chats.js")>()),
  patchChatEngagement: chatMocks.patchChatEngagement,
}));
vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ agentId: "human-agent-self" }),
}));
vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => {
    if (id === "agent-1") return "Nova";
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
    description: overrides.description ?? null,
    participants: overrides.participants ?? [
      participant("human-agent-self", "Gandy", "human"),
      participant("agent-1", "Nova"),
      participant("agent-2", "Design Critique"),
    ],
    participantCount: overrides.participantCount ?? 3,
    lastMessageAt: overrides.lastMessageAt ?? "2026-05-28T11:59:00.000Z",
    // Honor an explicit `null` (chat with no messages) — `??` would silently
    // replace it with the derived default and defeat skeleton-path tests.
    lastMessagePreview:
      "lastMessagePreview" in overrides ? (overrides.lastMessagePreview ?? null) : `Preview for ${overrides.title}`,
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

const BASE_ROWS: MeChatRow[] = [
  row({
    chatId: "chat-failed",
    title: "Broken deploy",
    failedAgentIds: ["agent-1"],
    unreadMentionCount: 3,
    chatHasExplicitMentionToMe: true,
    pinnedAt: null,
    activityAt: null,
  }),
  row({
    chatId: "chat-needs",
    title: "Waiting approval",
    // An open ask (R2) — pins to "Needs attention". The unread badge below
    // still renders (unreadMentionCount: 1), but the mention is no longer
    // what pins the row; the open request is.
    openRequestCount: 1,
    unreadMentionCount: 1,
    chatHasExplicitMentionToMe: true,
    pinnedAt: null,
    activityAt: null,
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

// Model the server priority projection the way the wire does: attention = the
// failed / open-request rows (server order preserved), pinned = pinned rows not
// already in attention. Ordinary `rows` stay ADDITIVE (they still include the
// priority chats); the component de-duplicates them against the groups.
function priorityFrom(rows: MeChatRow[]): MeChatPriorityRows {
  const attention = rows.filter((r) => r.failedAgentIds.length > 0 || r.openRequestCount > 0);
  const attentionIds = new Set(attention.map((r) => r.chatId));
  const pinned = rows.filter((r) => r.pinnedAt !== null && !attentionIds.has(r.chatId));
  return { attention, pinned };
}

// The rail uses `useInfiniteQuery`, so seeded cache entries must be the
// `InfiniteData` shape (`{ pages, pageParams }`). Priority groups ride on the
// FIRST page only, matching the server contract.
function page(
  rows: MeChatRow[],
  nextCursor: string | null = null,
): {
  pages: ListMeChatsResponse[];
  pageParams: Array<string | undefined>;
} {
  return {
    pages: [{ rows, nextCursor, priorityRows: priorityFrom(rows) }],
    pageParams: [undefined],
  };
}

function createClient(rows = BASE_ROWS, nextCursor: string | null = "cursor-1"): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(["me", "chats", "all", "active", false, null, null], page(rows, nextCursor));
  queryClient.setQueryData(["me", "chats", "unread", "active", false, "manual,github", "agent-1"], page([], null));
  queryClient.setQueryData(
    ["me", "chats", "all", "archived", false, null, null],
    page([row({ chatId: "chat-archived", title: "Archived review", engagementStatus: "archived" })], null),
  );
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
    expect(container.textContent).toContain("From GitHub");
    expect(container.querySelector('[aria-label="watching"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="failed, 3 unread"]')).toBeTruthy();
    // The open-ask row carries the "needs you" badge alongside its unread count.
    expect(container.querySelector('[aria-label="needs you, 1 unread"]')).toBeTruthy();

    await click(rowButton(container, "Manual planning"));
    expect(onSelectChat).toHaveBeenCalledWith("chat-manual");

    await click(buttonByText(container, "New chat"));
    expect(onNewChat).toHaveBeenCalledTimes(1);

    await click(buttonByText(container, "Load more"));
    expect(meChatMocks.listMeChats).toHaveBeenCalledWith(
      {
        filter: "all",
        engagement: "active",
        watching: undefined,
        origin: undefined,
        with: undefined,
        cursor: "cursor-1",
      },
      { signal: expect.anything() },
    );
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
    // Source now defaults to all-checked (no zero-source state); unchecking Agent
    // narrows to Human + GitHub, which the Unread assertion below expects.
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("Agent")) ?? null,
    );
    expect(container.textContent).toContain("Filters");
    expect(container.textContent).toContain("Human");
    expect(container.textContent).toContain("GitHub");

    await click(buttonByText(container, "Unread"));
    await flush();
    expect(meChatMocks.listMeChats).toHaveBeenCalledWith(
      {
        filter: "unread",
        engagement: "active",
        watching: undefined,
        origin: ["manual", "github"],
        with: undefined,
        cursor: undefined,
      },
      { signal: expect.anything() },
    );

    // Footer "Reset" is the LAST such button (per-section Source "Reset" renders
    // first once Source is narrowed).
    await click(
      [...document.body.querySelectorAll("button")].filter((button) => button.textContent === "Reset").at(-1) ?? null,
    );
    expect(container.textContent).not.toContain("Filters");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);

    await click(container.querySelector('button[aria-haspopup="listbox"]'));
    // Target the listbox option (not the trigger, which now also reads "Recent").
    await click(
      [...document.body.querySelectorAll('[role="option"]')].find((button) => button.textContent === "Recent") ?? null,
    );
    expect(container.textContent).toContain("Older");

    await click(container.querySelector('button[aria-label="Filter"]'));
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("Archived")) ?? null,
    );
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("Active")) ?? null,
    );
    await flush();
    expect(meChatMocks.listMeChats).toHaveBeenCalledWith(
      {
        filter: "all",
        engagement: "archived",
        watching: undefined,
        origin: undefined,
        with: undefined,
        cursor: undefined,
      },
      { signal: expect.anything() },
    );
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
    // A failed "Load more" surfaces a retry affordance instead of the empty
    // state or a leaked raw error string.
    expect(error.textContent).toContain("Couldn't load more");
    expect(error.textContent).not.toContain("No conversations yet.");
    await act(async () => root?.unmount());
    root = null;

    const draft = await renderDom(<StatefulList selectedChatId={DRAFT_CHAT_ID} nextCursor={null} />);
    expect(buttonByText(draft, "New chat").getAttribute("aria-current")).toBe("page");
  });

  it("keeps the unread filter selected when there are no unread chats", async () => {
    const readOnlyRows = [row({ chatId: "chat-read", title: "Read chat" })];
    const container = await renderDom(
      <StatefulList rows={readOnlyRows} nextCursor={null} />,
      createClient(readOnlyRows, null),
    );

    expect(buttonByText(container, "Unread").getAttribute("aria-pressed")).toBe("false");

    await click(buttonByText(container, "Unread"));

    expect(meChatMocks.listMeChats).toHaveBeenCalledWith(
      {
        filter: "unread",
        engagement: "active",
        watching: undefined,
        origin: undefined,
        with: undefined,
        cursor: undefined,
      },
      { signal: expect.anything() },
    );
    expect(buttonByText(container, "Unread").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByText(container, "All").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("No unread conversations.");
    expect(container.textContent).toContain("All caught up.");
    expect(container.textContent).not.toContain("Start with New chat.");
  });

  it("renders single-line rows: no description / preview second line, no skeleton", async () => {
    const rows = [
      row({ chatId: "chat-desc", title: "Has summary", description: "reviewing PR 916; CI green; awaiting approval" }),
      row({ chatId: "chat-nodesc", title: "No summary", description: null, lastMessagePreview: "ack — looking now" }),
      row({ chatId: "chat-empty", title: "Empty chat", description: null, lastMessagePreview: null }),
    ];
    const container = await renderDom(<StatefulList rows={rows} nextCursor={null} />, createClient(rows, null));

    // Rows are title-only: neither the chat description nor the last-message
    // preview renders in the list (the chat header is the surface that shows
    // the description in full).
    expect(container.textContent).not.toContain("reviewing PR 916; CI green; awaiting approval");
    const withFallback = rowButton(container, "No summary");
    expect(withFallback.textContent).not.toContain("ack — looking now");

    // No skeleton placeholder either — single-line rows need no second-line
    // height keeper.
    for (const title of ["Has summary", "No summary", "Empty chat"]) {
      expect(rowButton(container, title).querySelector('[data-testid="row-description-skeleton"]')).toBeNull();
    }
  });

  it("shows an error with retry when the first page fails, not an empty state", async () => {
    const errorClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
    });
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockRejectedValue(new Error("network down"));

    const container = await renderDom(<StatefulList rows={[]} nextCursor={null} />, errorClient);

    // A failed first page must NOT masquerade as the "nothing here yet" state.
    expect(container.textContent).not.toContain("No conversations yet.");
    expect(container.textContent).toContain("Couldn't load conversations");
    expect(buttonByText(container, "Retry")).toBeTruthy();
  });

  it("recovers when the first-page error is retried", async () => {
    const retryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
    });
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ rows: [row({ chatId: "chat-ok", title: "Recovered chat" })], nextCursor: null });

    const container = await renderDom(<StatefulList rows={[]} nextCursor={null} />, retryClient);
    expect(container.textContent).toContain("Couldn't load conversations");

    await click(buttonByText(container, "Retry"));
    expect(container.textContent).toContain("Recovered chat");
    expect(container.textContent).not.toContain("Couldn't load conversations");
  });

  it("de-duplicates a chat that appears on more than one page", async () => {
    const dupClient = createClient([row({ chatId: "chat-dup", title: "Duplicated chat" })], "cursor-1");
    meChatMocks.listMeChats.mockReset();
    // A background refetch can pull a page-2 chat into page 1, so the same
    // chatId briefly lives on two pages. The rail must render it once.
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [row({ chatId: "chat-dup", title: "Duplicated chat" }), row({ chatId: "chat-two", title: "Second chat" })],
      nextCursor: null,
    });

    const container = await renderDom(<StatefulList />, dupClient);
    await click(buttonByText(container, "Load more"));

    const dupRows = [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Duplicated chat"));
    expect(dupRows.length).toBe(1);
    expect(container.textContent).toContain("Second chat");
  });

  it("renders a Pinned group from the server projection and shows the pinned chat once", async () => {
    // A pinned row (server `priorityRows.pinned`) hoists into a "Pinned" group and
    // is de-duplicated OUT of the ordinary recency list — shown exactly once.
    const rows = [
      row({ chatId: "chat-pinned", title: "Pinned thread", pinnedAt: "2026-05-20T09:00:00.000Z" }),
      row({ chatId: "chat-plain", title: "Plain thread" }),
    ];
    const container = await renderDom(
      <StatefulList rows={rows} nextCursor={null} selectedChatId={null} />,
      createClient(rows, null),
    );

    // The collapsible "Pinned" group header renders (group headers carry
    // `aria-expanded`; row buttons and the Manage-chat trigger do not carry the
    // "Pinned" label).
    const pinnedHeader = [...container.querySelectorAll("button[aria-expanded]")].find((b) =>
      b.textContent?.includes("Pinned"),
    );
    expect(pinnedHeader).toBeTruthy();
    const pinnedRows = [...container.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("Pinned thread"),
    );
    expect(pinnedRows.length).toBe(1);
    expect(container.textContent).toContain("Plain thread");
  });

  it("does not show the empty state when the only chat is a pinned chat", async () => {
    // Regression (both PR4 reviews): `rows` is additive and every priority chat is
    // de-duplicated OUT of the recency list, so an all-priority list has an empty
    // recency list. The empty state must key off the WHOLE rendered set —
    // otherwise "No conversations yet" paints directly above the Pinned group.
    const rows = [row({ chatId: "chat-only-pinned", title: "Only pinned", pinnedAt: "2026-05-20T09:00:00.000Z" })];
    const container = await renderDom(
      <StatefulList rows={rows} nextCursor={null} selectedChatId={null} />,
      createClient(rows, null),
    );

    expect(container.textContent).not.toContain("No conversations yet.");
    expect(container.textContent).toContain("Pinned");
    expect(container.textContent).toContain("Only pinned");
  });

  it("does not show the empty state when the only chat needs attention", async () => {
    const rows = [row({ chatId: "chat-only-failed", title: "Only failed", failedAgentIds: ["agent-1"] })];
    const container = await renderDom(
      <StatefulList rows={rows} nextCursor={null} selectedChatId={null} />,
      createClient(rows, null),
    );

    expect(container.textContent).not.toContain("No conversations yet.");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Only failed");
  });

  it("shows Load more when the whole first page is priority rows but more pages remain", async () => {
    // The recency list is empty on page 1 (its one row deduped into Pinned), yet
    // more ordinary chats wait on page 2 — "Load more" must still render (keyed
    // off the whole rendered set) so they stay reachable.
    const rows = [row({ chatId: "chat-page1-pin", title: "Page one pin", pinnedAt: "2026-05-20T09:00:00.000Z" })];
    const container = await renderDom(
      <StatefulList rows={rows} nextCursor="cursor-1" selectedChatId={null} />,
      createClient(rows, "cursor-1"),
    );

    expect(buttonByText(container, "Load more")).toBeTruthy();
  });

  it("de-duplicates a Needs-attention chat — renders exactly once", async () => {
    // Count-guard the attention half of the priority dedup (the Pinned half is
    // guarded above). A regression narrowing `priorityIds` to pinned-only would
    // double-render every attention row; `.toContain` would miss it, this won't.
    const rows = [
      row({ chatId: "chat-att", title: "Attention chat", failedAgentIds: ["agent-1"] }),
      row({ chatId: "chat-plain2", title: "Plain two" }),
    ];
    const container = await renderDom(
      <StatefulList rows={rows} nextCursor={null} selectedChatId={null} />,
      createClient(rows, null),
    );

    const attRows = [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Attention chat"));
    expect(attRows.length).toBe(1);
    expect(container.textContent).toContain("Needs attention");
  });

  it("shows the ⚙ badge as a DIMENSION count (monotonic), driven by the real component", async () => {
    // Guards the production `popoverFilterCount` (index.tsx), NOT the harness
    // copy: narrowing Source from 2 sources to 1 must NOT drop the badge, and a
    // narrowed Source + non-default Status reads 2 (dimensions), not 3 (values).
    const container = await renderDom(<StatefulList selectedChatId={null} />);
    const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label="Filter"]');
    expect(trigger()?.textContent ?? "").not.toMatch(/[0-9]/);

    await click(trigger() ?? null);
    const labelByText = (t: string): Element | null =>
      [...document.body.querySelectorAll("label")].find((l) => l.textContent?.includes(t)) ?? null;
    await click(labelByText("Archived")); // Status → non-default (dimension 1)
    await click(labelByText("Agent")); // Source → 2 of 3 selected (dimension 2)
    await flush();
    expect(trigger()?.textContent).toContain("2");
    expect(trigger()?.textContent).not.toContain("3");

    await click(labelByText("GitHub")); // Source → 1 of 3: dimension count stays 2
    await flush();
    expect(trigger()?.textContent).toContain("2");
  });

  it("keeps the empty state when a background refetch fails, not an error", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
    });
    meChatMocks.listMeChats.mockReset();
    // First load succeeds with no chats; the next (background) refetch fails.
    meChatMocks.listMeChats
      .mockResolvedValueOnce({ rows: [], nextCursor: null })
      .mockRejectedValue(new Error("refetch blip"));

    const container = await renderDom(<StatefulList rows={[]} nextCursor={null} />, client);
    expect(container.textContent).toContain("No conversations yet.");

    // React Query retains the (empty) data on a refetch failure, so this must
    // NOT flip a legitimately-empty list into the first-load error state.
    await act(async () => {
      await client.refetchQueries({ queryKey: ["me", "chats"] }).catch(() => undefined);
    });
    await flush();
    expect(container.textContent).toContain("No conversations yet.");
    expect(container.textContent).not.toContain("Couldn't load conversations");
  });

  it("refreshes clock-derived row times after a successful refetch with an unchanged payload", async () => {
    // Fake only the clock so `flush()`'s real setTimeout still resolves.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
      });
      // Each fetch returns a fresh object with structurally-identical rows, so
      // React Query keeps `data` identity across refetches (structural sharing).
      meChatMocks.listMeChats.mockReset();
      meChatMocks.listMeChats.mockImplementation(async () => ({
        rows: [row({ chatId: "chat-time", title: "Timed chat", lastMessageAt: "2026-05-28T11:58:00.000Z" })],
        nextCursor: null,
      }));

      const container = await renderDom(<StatefulList rows={[]} nextCursor={null} />, client);
      expect(rowButton(container, "Timed chat").textContent).toContain("2m");

      // Advance an hour, then a successful (structurally identical) refetch. The
      // relative time must refresh even though `data` keeps its identity — the
      // component tracks `dataUpdatedAt` as the successful-refetch clock.
      vi.setSystemTime(new Date("2026-05-28T13:00:00.000Z"));
      await act(async () => {
        await client.refetchQueries({ queryKey: ["me", "chats"] });
      });
      await flush();

      expect(rowButton(container, "Timed chat").textContent).toContain("1h");
      expect(rowButton(container, "Timed chat").textContent).not.toContain("2m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the selected row with aria-current and reveals the row-actions kebab on touch", async () => {
    const container = await renderDom(<StatefulList selectedChatId="chat-manual" />);
    // Row selection is exposed to assistive tech (was tint + left bar only).
    expect(rowButton(container, "Manual planning").getAttribute("aria-current")).toBe("page");
    expect(rowButton(container, "Broken deploy").getAttribute("aria-current")).toBeNull();
    // The row-actions kebab (the only Pin entry point) reveals on coarse (touch)
    // pointers, not hover-only, so Pin is reachable on phones / the narrow overlay.
    const kebab = container.querySelector('button[aria-label="Manage chat"]');
    expect(kebab?.className).toContain("pointer-coarse:opacity-100");
  });
});
