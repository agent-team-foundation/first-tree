// @vitest-environment happy-dom

import type { Agent, MeChatRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const orgAgentsMock = vi.hoisted(() => ({
  value: { items: [] as Agent[], nextCursor: null as string | null },
  isLoading: false,
}));

vi.mock("../../../../api/me-chats.js", () => meChatMocks);

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ agentId: "human-agent-self" }),
}));

vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => (id === "agent-1" ? "Nova" : (id ?? "unknown")),
}));

vi.mock("../../../../lib/use-org-agents.js", () => ({
  useOrgAgents: () => ({ data: orgAgentsMock.value, isLoading: orgAgentsMock.isLoading }),
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => routerMocks.navigate,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "agent-1-inbox",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function chatRow(overrides: Partial<MeChatRow> = {}): MeChatRow {
  const participants = [
    {
      agentId: "human-agent-self",
      name: "gandy",
      displayName: "Gandy",
      type: "human" as const,
      avatarColorToken: null,
      avatarImageUrl: null,
    },
    {
      agentId: "agent-1",
      name: "nova",
      displayName: "Nova",
      type: "agent" as const,
      avatarColorToken: null,
      avatarImageUrl: null,
    },
  ];
  return {
    chatId: overrides.chatId ?? "chat-123456789",
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Launch planning",
    topic: overrides.topic ?? "Release train",
    description: overrides.description ?? null,
    participants: overrides.participants ?? participants,
    participantCount: overrides.participantCount ?? participants.length,
    // `??` would swallow an explicit `null` (a never-messaged chat) — use
    // an `in` check so tests can express that state.
    lastMessageAt: "lastMessageAt" in overrides ? (overrides.lastMessageAt ?? null) : NOW,
    lastMessagePreview: overrides.lastMessagePreview ?? "Ship it.",
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

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={createClient()}>{element}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function commandItemByText(container: ParentNode, text: string): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) => item.textContent?.includes(text)) ?? null
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  orgAgentsMock.value = {
    items: [agent(), agent({ uuid: "agent-2", name: null, displayName: "No Handle" })],
    nextCursor: null,
  };
  orgAgentsMock.isLoading = false;
  meChatMocks.listMeChats.mockResolvedValue({
    rows: [chatRow(), chatRow({ chatId: "chat-untitled", title: "", topic: null })],
    nextCursor: null,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("CommandPalette", () => {
  it("fetches open-only data while visible and navigates from chat and teammate items", async () => {
    const onOpenChange = vi.fn();
    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open onOpenChange={onOpenChange} />);

    await waitForText(document.body, "Launch planning");
    await waitForText(document.body, "(untitled)");
    await waitForText(document.body, "Nova");
    await waitForText(document.body, "No Handle");

    expect(meChatMocks.listMeChats).toHaveBeenCalledWith({ limit: 100, engagement: "all" });

    // Row noise is gone: the topic is no longer repeated next to the
    // title (title already derives from it), and the chat-id hash is
    // searchable but never rendered.
    expect(document.body.textContent).not.toContain("Release train");
    expect(document.body.textContent).not.toContain("chat-123");

    // The roster group is "Teammates" (humans + agents), and the static
    // "Pages" group is gone — both by design.
    expect(document.body.textContent).toContain("Teammates");
    expect(document.body.textContent).not.toContain("Agents");
    expect(document.body.textContent).not.toContain("Pages");
    expect(document.body.textContent).not.toContain("Workspace");

    // Regression: cmdk ≥1.0 puts `data-disabled="false"` on every enabled
    // item, so the disabled dim must use the value-matching selector — the
    // presence-matching form (`data-[disabled]:`) grayed out the whole list.
    const anyItem = commandItemByText(document.body, "Launch planning");
    expect(anyItem?.getAttribute("data-disabled")).toBe("false");
    expect(anyItem?.className).toContain("data-[disabled=true]:opacity-50");
    expect(anyItem?.className).not.toMatch(/data-\[disabled\]:/);

    await click(commandItemByText(document.body, "Launch planning"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(routerMocks.navigate).toHaveBeenLastCalledWith("/?c=chat-123456789");

    await click(commandItemByText(document.body, "Nova"));
    expect(routerMocks.navigate).toHaveBeenLastCalledWith("/agents/agent-1/profile");

    await act(async () => root.unmount());
  });

  it("shows a recency-sorted, capped Recent view while the query is empty", async () => {
    const rows = [
      chatRow({ chatId: "chat-old", title: "Oldest", lastMessageAt: "2026-05-01T00:00:00.000Z" }),
      chatRow({ chatId: "chat-new", title: "Newest", lastMessageAt: "2026-05-28T00:00:00.000Z" }),
      chatRow({ chatId: "chat-mid", title: "Middle", lastMessageAt: "2026-05-14T00:00:00.000Z" }),
      chatRow({ chatId: "chat-never", title: "Never messaged", lastMessageAt: null }),
      // Filler so the total (16) exceeds the 12-row empty-query cap.
      ...Array.from({ length: 12 }, (_, i) =>
        chatRow({ chatId: `chat-filler-${i}`, title: `Filler ${i}`, lastMessageAt: "2026-05-20T00:00:00.000Z" }),
      ),
    ];
    meChatMocks.listMeChats.mockResolvedValue({ rows, nextCursor: null });

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open onOpenChange={vi.fn()} />);
    await waitForText(document.body, "Newest");

    expect(document.body.textContent).toContain("Recent");

    const chatItems = [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].filter((el) =>
      el.getAttribute("data-value")?.includes("chat-"),
    );
    expect(chatItems).toHaveLength(12);
    // Most recent first; null lastMessageAt sinks past the cap entirely.
    expect(chatItems[0]?.textContent).toContain("Newest");
    expect(chatItems[1]?.textContent).toContain("Filler");
    expect(document.body.textContent).not.toContain("Never messaged");
    expect(document.body.textContent).not.toContain("Oldest");

    await act(async () => root.unmount());
  });

  it("marks archived chats and renders the compact age in the time slot", async () => {
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [
        chatRow({
          chatId: "chat-archived",
          title: "Old initiative",
          engagementStatus: "archived",
          lastMessageAt: "2026-01-05T00:00:00.000Z",
        }),
      ],
      nextCursor: null,
    });

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open onOpenChange={vi.fn()} />);
    await waitForText(document.body, "Old initiative");

    const item = commandItemByText(document.body, "Old initiative");
    expect(item?.textContent).toContain("Archived");
    expect(item?.textContent).toContain("01/05");

    await act(async () => root.unmount());
  });

  it("searches topic, description, and participant names via keywords and lifts the Recent cap", async () => {
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [
        chatRow({ chatId: "chat-a", title: "Launch planning", description: "reviewing PR #42", topic: null }),
        chatRow({ chatId: "chat-b", title: "Random other", description: null, topic: null }),
      ],
      nextCursor: null,
    });

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open onOpenChange={vi.fn()} />);
    await waitForText(document.body, "Launch planning");

    const input = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
    if (!input) throw new Error("Expected cmdk input");
    await act(async () => {
      // Native prototype setter so React's value tracker sees the change
      // (assigning `input.value` directly is swallowed as a duplicate).
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "reviewing");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "reviewing" }));
    });
    await flush();

    // Searching switches the group heading from Recent to Chats and
    // matches on the description keyword.
    expect(document.body.textContent).toContain("Chats");
    expect(document.body.textContent).not.toContain("Recent");
    expect(commandItemByText(document.body, "Launch planning")).not.toBeNull();
    expect(commandItemByText(document.body, "Random other")).toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps async palette queries disabled while closed and renders nothing", async () => {
    orgAgentsMock.value = { items: [], nextCursor: null };
    meChatMocks.listMeChats.mockResolvedValue({ rows: [], nextCursor: null });

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open={false} onOpenChange={vi.fn()} />);

    expect(document.body.querySelectorAll("[cmdk-item]")).toHaveLength(0);
    expect(meChatMocks.listMeChats).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("does not show the empty state while chat results are still loading", async () => {
    orgAgentsMock.value = { items: [], nextCursor: null };
    meChatMocks.listMeChats.mockReturnValue(new Promise(() => undefined));

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open onOpenChange={vi.fn()} />);

    expect(document.body.textContent).not.toContain("No results");
    expect(document.body.querySelector(".animate-pulse")).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("does not show the empty state while teammates are still loading", async () => {
    orgAgentsMock.value = { items: [], nextCursor: null };
    orgAgentsMock.isLoading = true;
    meChatMocks.listMeChats.mockResolvedValue({ rows: [], nextCursor: null });

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open onOpenChange={vi.fn()} />);

    expect(document.body.textContent).not.toContain("No results");

    await act(async () => root.unmount());
  });

  it("renders injected demo data without fetching live chats", async () => {
    orgAgentsMock.value = { items: [], nextCursor: null };

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        demoData={{
          chats: [
            chatRow({ chatId: "demo-new", title: "Demo newest", lastMessageAt: "2026-05-28T12:00:00.000Z" }),
            chatRow({
              chatId: "demo-archived",
              title: "Archived audit trail",
              engagementStatus: "archived",
              lastMessageAt: "2026-05-27T12:00:00.000Z",
            }),
          ],
          agents: [
            agent({ uuid: "demo-agent-a", name: "maya", displayName: "Maya Chen" }),
            agent({ uuid: "demo-agent-b", name: "ops", displayName: "Ops Reviewer" }),
          ],
        }}
      />,
    );

    await waitForText(document.body, "Demo newest");

    expect(meChatMocks.listMeChats).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Recent");
    expect(document.body.textContent).toContain("Archived audit trail");
    expect(document.body.textContent).toContain("Archived");
    expect(document.body.textContent).toContain("Teammates");
    expect(document.body.textContent).toContain("Maya Chen");
    expect(document.body.textContent).toContain("Ops Reviewer");

    await act(async () => root.unmount());
  });
});
