// @vitest-environment happy-dom

import type { ChatDetail, ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type WsMessage = { type: string; chatId?: string };

const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
}));

const meChatMocks = vi.hoisted(() => ({
  joinMeChat: vi.fn(),
  markMeChatRead: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    agentId: "human-agent-self" as string | null,
    organizationId: "org-1" as string | null,
  },
}));

const wsMock = vi.hoisted(() => ({
  handler: null as ((message: WsMessage) => void) | null,
}));

const chatViewMocks = vi.hoisted(() => ({
  props: [] as Array<{
    agentId: string;
    chatId: string;
    readOnly?: boolean;
    titleFallback?: string | null;
    joinAction?: {
      onJoin: () => void;
      joining: boolean;
      error: string | null;
    };
    narrow: boolean;
    onShowConversations: (() => void) | null;
  }>,
}));

const draftMocks = vi.hoisted(() => ({
  props: [] as Array<{
    onCreated: (chatId: string) => void;
    onShowConversations: (() => void) | null;
    initialParticipantIds?: string[];
  }>,
}));

vi.mock("../../../../api/chats.js", () => chatMocks);

vi.mock("../../../../api/me-chats.js", () => meChatMocks);

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../../hooks/use-admin-ws.js", () => ({
  useAdminWs: ({ onMessage }: { onMessage: (message: WsMessage) => void }) => {
    wsMock.handler = onMessage;
  },
}));

vi.mock("../chat-view.js", async () => {
  const React = await import("react");
  return {
    ChatView: (props: (typeof chatViewMocks.props)[number]) => {
      chatViewMocks.props.push(props);
      return React.createElement(
        "div",
        { "data-testid": "chat-view" },
        [
          `ChatView ${props.agentId} ${props.chatId}`,
          props.readOnly ? " read-only" : "",
          props.titleFallback ? ` ${props.titleFallback}` : "",
          props.joinAction?.error ? ` ${props.joinAction.error}` : "",
        ].join(""),
        props.joinAction
          ? React.createElement("button", { type: "button", onClick: props.joinAction.onJoin }, "Join chat")
          : null,
      );
    },
  };
});

vi.mock("../../conversations/new-chat-draft.js", async () => {
  const React = await import("react");
  return {
    NewChatDraft: (props: (typeof draftMocks.props)[number]) => {
      draftMocks.props.push(props);
      return React.createElement(
        "div",
        { "data-testid": "new-chat-draft" },
        "Draft",
        React.createElement("button", { type: "button", onClick: () => props.onCreated("created-chat") }, "Created"),
      );
    },
  };
});

const NOW = "2026-05-28T12:00:00.000Z";

function participant(
  overrides: Partial<ChatParticipantDetail> & { agentId: string; type: string },
): ChatParticipantDetail {
  return {
    agentId: overrides.agentId,
    role: overrides.role ?? "member",
    mode: overrides.mode ?? "speaker",
    joinedAt: overrides.joinedAt ?? NOW,
    name: overrides.name ?? overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    type: overrides.type,
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

function chatDetail(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    id: overrides.id ?? "chat-1",
    organizationId: overrides.organizationId ?? "org-1",
    type: overrides.type ?? "group",
    topic: overrides.topic ?? "Launch",
    description: overrides.description ?? null,
    lifecyclePolicy: overrides.lifecyclePolicy ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    participants: overrides.participants ?? [
      participant({ agentId: "human-agent-self", type: "human", displayName: "Gandy" }),
      participant({ agentId: "agent-1", type: "agent", displayName: "Kael" }),
      participant({ agentId: "human-agent-alice", type: "human", displayName: "Alice" }),
    ],
    title: overrides.title ?? "Launch chat",
    firstMessagePreview: overrides.firstMessagePreview ?? null,
    engagementStatus: overrides.engagementStatus ?? "active",
    viewerMembershipKind:
      "viewerMembershipKind" in overrides ? (overrides.viewerMembershipKind ?? null) : "participant",
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
    root.render(<QueryClientProvider client={createClient()}>{element}</QueryClientProvider>);
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

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  wsMock.handler = null;
  chatViewMocks.props.length = 0;
  draftMocks.props.length = 0;
  authMock.value = { agentId: "human-agent-self", organizationId: "org-1" };
  chatMocks.getChat.mockResolvedValue(chatDetail());
  meChatMocks.markMeChatRead.mockResolvedValue({});
  meChatMocks.joinMeChat.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatByIdView and CenterPanel", () => {
  it("picks the first non-human non-self agent and marks readable chats on mount and websocket frames", async () => {
    const { ChatByIdView } = await import("../chat-by-id.js");
    const onShowConversations = vi.fn();
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-1" narrow onShowConversations={onShowConversations} />,
    );

    await waitForText(container, "ChatView agent-1 chat-1");
    expect(chatMocks.getChat).toHaveBeenCalledWith("chat-1");
    expect(meChatMocks.markMeChatRead).toHaveBeenCalledTimes(1);
    expect(chatViewMocks.props.at(-1)).toMatchObject({
      agentId: "agent-1",
      chatId: "chat-1",
      narrow: true,
      onShowConversations,
    });

    await act(async () => {
      wsMock.handler?.({ type: "chat:message", chatId: "other-chat" });
      wsMock.handler?.({ type: "chat:message", chatId: "chat-1" });
      wsMock.handler?.({ type: "ws:reconnect" });
    });
    await flush();
    expect(meChatMocks.markMeChatRead).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
  });

  it("falls back to a non-self human, skips mark-read for supervisor views, and shows loading without participants", async () => {
    chatMocks.getChat.mockResolvedValueOnce(
      chatDetail({
        participants: [
          participant({ agentId: "human-agent-self", type: "human" }),
          participant({ agentId: "human-agent-alice", type: "human", displayName: "Alice" }),
        ],
        viewerMembershipKind: null,
      }),
    );
    const { ChatByIdView } = await import("../chat-by-id.js");
    const fallback = await renderDom(<ChatByIdView chatId="chat-2" narrow={false} onShowConversations={null} />);
    await waitForText(fallback.container, "ChatView human-agent-alice chat-2");
    expect(meChatMocks.markMeChatRead).not.toHaveBeenCalled();
    await act(async () => fallback.root.unmount());

    chatMocks.getChat.mockResolvedValueOnce(
      chatDetail({ participants: [participant({ agentId: "human-agent-self", type: "human" })] }),
    );
    const loading = await renderDom(<ChatByIdView chatId="chat-3" narrow={false} onShowConversations={null} />);
    await waitForText(loading.container, "Resolving participants");
    await act(async () => loading.root.unmount());
  });

  it("passes watcher join state into ChatView and invalidates via the join action", async () => {
    chatMocks.getChat.mockResolvedValueOnce(chatDetail({ viewerMembershipKind: "watching", title: "Watch title" }));
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-watch" narrow={false} onShowConversations={null} />,
    );

    await waitForText(container, "read-only");
    expect(chatViewMocks.props.at(-1)?.titleFallback).toBe("Watch title");
    await click(container.querySelector("button"));
    expect(meChatMocks.joinMeChat).toHaveBeenCalledWith("chat-watch");

    await act(async () => root.unmount());
  });

  it("routes CenterPanel between draft, selected chat, and empty state", async () => {
    const { CenterPanel } = await import("../index.js");
    const onSelectChat = vi.fn();
    const onShowConversations = vi.fn();

    const draft = await renderDom(
      <CenterPanel
        selectedChatId="draft"
        onSelectChat={onSelectChat}
        narrow
        onShowConversations={onShowConversations}
        initialParticipantIds={["agent-1"]}
      />,
    );
    expect(draft.container.textContent).toContain("Draft");
    expect(draftMocks.props.at(-1)).toMatchObject({
      onShowConversations,
      initialParticipantIds: ["agent-1"],
    });
    await click(draft.container.querySelector("button"));
    expect(onSelectChat).toHaveBeenCalledWith("created-chat");
    await act(async () => draft.root.unmount());

    const selected = await renderDom(
      <CenterPanel selectedChatId="chat-1" onSelectChat={onSelectChat} narrow={false} onShowConversations={null} />,
    );
    await waitForText(selected.container, "ChatView agent-1 chat-1");
    await act(async () => selected.root.unmount());

    const empty = await renderDom(
      <CenterPanel selectedChatId={null} onSelectChat={onSelectChat} narrow={false} onShowConversations={null} />,
    );
    await click(
      [...empty.container.querySelectorAll("button")].find((button) => button.textContent?.includes("New chat")) ??
        null,
    );
    expect(onSelectChat).toHaveBeenCalledWith("draft");
    await act(async () => empty.root.unmount());
  });
});
