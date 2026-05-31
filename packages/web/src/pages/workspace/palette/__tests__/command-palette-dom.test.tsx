// @vitest-environment happy-dom

import type { Agent, Attention, MeChatRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const attentionMocks = vi.hoisted(() => ({
  listMyAttentions: vi.fn(),
  myAttentionsQueryKey: ["attentions", "me"] as const,
}));

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const orgAgentsMock = vi.hoisted(() => ({
  value: { items: [] as Agent[], nextCursor: null as string | null },
}));

vi.mock("../../../../api/attention.js", () => attentionMocks);

vi.mock("../../../../api/me-chats.js", () => meChatMocks);

vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => (id === "agent-1" ? "Kael" : (id ?? "unknown")),
}));

vi.mock("../../../../lib/use-org-agents.js", () => ({
  useOrgAgents: () => ({ data: orgAgentsMock.value }),
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => routerMocks.navigate,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "kael",
    displayName: overrides.displayName ?? "Kael",
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
      name: "kael",
      displayName: "Kael",
      type: "agent" as const,
      avatarColorToken: null,
      avatarImageUrl: null,
    },
  ];
  return {
    chatId: overrides.chatId ?? "chat-123456789",
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Launch planning",
    topic: overrides.topic ?? "Release train",
    participants: overrides.participants ?? participants,
    participantCount: overrides.participantCount ?? participants.length,
    lastMessageAt: overrides.lastMessageAt ?? NOW,
    lastMessagePreview: overrides.lastMessagePreview ?? "Ship it.",
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    pendingQuestionAgentIds: overrides.pendingQuestionAgentIds ?? [],
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasOpenQuestion: overrides.chatHasOpenQuestion ?? false,
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
  };
}

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    id: overrides.id ?? "attention-123456789",
    originAgentId: overrides.originAgentId ?? "agent-1",
    originChatId: overrides.originChatId ?? "chat-123456789",
    targetHumanId: overrides.targetHumanId ?? "human-agent-self",
    subject: overrides.subject ?? "Approve rollout",
    body: overrides.body ?? "Can I ship this train now?",
    requiresResponse: overrides.requiresResponse ?? true,
    state: overrides.state ?? "open",
    response: overrides.response ?? null,
    respondedBy: overrides.respondedBy ?? null,
    respondedAt: overrides.respondedAt ?? null,
    cancelled: overrides.cancelled ?? false,
    cancelledReason: overrides.cancelledReason ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? NOW,
    closedAt: overrides.closedAt ?? null,
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
  meChatMocks.listMeChats.mockResolvedValue({
    rows: [chatRow(), chatRow({ chatId: "chat-untitled", title: "", topic: null })],
    nextCursor: null,
  });
  attentionMocks.listMyAttentions.mockResolvedValue([attention()]);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("CommandPalette", () => {
  it("fetches open-only data while visible and navigates from chat, agent, attention, and page items", async () => {
    const onOpenChange = vi.fn();
    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open onOpenChange={onOpenChange} />);

    await waitForText(document.body, "Launch planning");
    await waitForText(document.body, "(untitled)");
    await waitForText(document.body, "Release train");
    await waitForText(document.body, "Kael");
    await waitForText(document.body, "No Handle");
    await waitForText(document.body, "Approve rollout");
    await waitForText(document.body, "from Kael");
    await waitForText(document.body, "Workspace");

    expect(meChatMocks.listMeChats).toHaveBeenCalledWith({ limit: 100, engagement: "all" });
    expect(attentionMocks.listMyAttentions).toHaveBeenCalledTimes(1);

    await click(commandItemByText(document.body, "Launch planning"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(routerMocks.navigate).toHaveBeenLastCalledWith("/?c=chat-123456789");

    await click(commandItemByText(document.body, "Kael"));
    expect(routerMocks.navigate).toHaveBeenLastCalledWith("/agents/agent-1/profile");

    await click(commandItemByText(document.body, "Approve rollout"));
    expect(routerMocks.navigate).toHaveBeenLastCalledWith("/?c=chat-123456789");

    await click(commandItemByText(document.body, "Settings"));
    expect(routerMocks.navigate).toHaveBeenLastCalledWith("/settings");

    await act(async () => root.unmount());
  });

  it("keeps async palette queries disabled while closed and still renders static pages", async () => {
    orgAgentsMock.value = { items: [], nextCursor: null };
    meChatMocks.listMeChats.mockResolvedValue({ rows: [], nextCursor: null });
    attentionMocks.listMyAttentions.mockResolvedValue([]);

    const { CommandPalette } = await import("../command-palette.js");
    const { root } = await renderDom(<CommandPalette open={false} onOpenChange={vi.fn()} />);

    expect(document.body.textContent).not.toContain("Workspace");
    expect(meChatMocks.listMeChats).not.toHaveBeenCalled();
    expect(attentionMocks.listMyAttentions).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
