// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const answerMocks = vi.hoisted(() => ({
  sendAskAnswer: vi.fn(),
}));
const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  listChatMessages: vi.fn(),
}));
const meChatMocks = vi.hoisted(() => ({
  listNeedYouRequests: vi.fn(),
}));

vi.mock("../../../../api/chats.js", () => chatMocks);
vi.mock("../../../../api/me-chats.js", () => meChatMocks);
vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ organizationId: "org-1", agentId: "human-1" }),
}));
vi.mock("../../../../components/chat/ask-answer-transport.js", () => answerMocks);
vi.mock("../../../../components/chat/use-ask-agent.js", () => ({
  useAskAgent: () => ({
    exchanges: [],
    waiting: false,
    sending: false,
    error: null,
    ask: vi.fn(),
  }),
}));
vi.mock("../../../../hooks/use-gitlab-entity-presentation.js", () => ({
  useGitlabEntityPresentation: () => ({ markdownComponents: undefined }),
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("NeedYouPage request resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answerMocks.sendAskAnswer.mockResolvedValue(undefined);
    meChatMocks.listNeedYouRequests.mockResolvedValue({ items: [], total: 0, nextCursor: null });
  });

  it("uses an explicit closed resolution when Skip is selected", async () => {
    const { NeedYouPage } = await import("../need-you-page.js");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(["need-you", "org-1"], {
      items: [
        {
          request: {
            id: "request-1",
            chatId: "chat-1",
            senderId: "asker-1",
            format: "request",
            content: "Choose the rollout.",
            metadata: { mentions: ["human-1"], request: { multiSelect: false } },
            inReplyTo: null,
            source: "api",
            createdAt: "2026-07-30T00:00:00.000Z",
          },
          chat: {
            id: "chat-1",
            title: "Rollout",
            topic: "Rollout",
            description: null,
          },
          asker: {
            agentId: "asker-1",
            name: "asker",
            displayName: "Asker",
            avatarColorToken: null,
            avatarImageUrl: null,
          },
        },
      ],
      total: 1,
      nextCursor: null,
    });
    queryClient.setQueryData(["chat-detail", "chat-1"], {
      id: "chat-1",
      type: "group",
      organizationId: "org-1",
      participants: [],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NeedYouPage onClose={vi.fn()} onOpenFullChat={vi.fn()} />
        </QueryClientProvider>,
      );
    });
    await flush();

    const skip = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Skip");
    if (!skip) throw new Error("Missing Skip button");
    await act(async () => {
      skip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(answerMocks.sendAskAnswer).toHaveBeenCalledWith({
      chatId: "chat-1",
      request: expect.objectContaining({ id: "request-1", senderId: "asker-1" }),
      answer: {
        content: "(Skipped — no answer provided.)",
        mentions: [],
        images: [],
      },
      resolutionKind: "closed",
    });

    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it("opens the full chat focused on the asker from Show earlier chat", async () => {
    const { NeedYouPage } = await import("../need-you-page.js");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(["need-you", "org-1"], {
      items: [
        {
          request: {
            id: "request-1",
            chatId: "chat-1",
            senderId: "asker-1",
            format: "request",
            content: "Choose the rollout.",
            metadata: { mentions: ["human-1"], request: { multiSelect: false } },
            inReplyTo: null,
            source: "api",
            createdAt: "2026-07-30T00:00:00.000Z",
          },
          chat: {
            id: "chat-1",
            title: "Rollout",
            topic: "Rollout",
            description: null,
          },
          asker: {
            agentId: "asker-1",
            name: "asker",
            displayName: "Asker",
            avatarColorToken: null,
            avatarImageUrl: null,
          },
        },
      ],
      total: 1,
      nextCursor: null,
    });
    queryClient.setQueryData(["chat-detail", "chat-1"], {
      id: "chat-1",
      type: "group",
      organizationId: "org-1",
      participants: [],
    });

    const onOpenFullChat = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NeedYouPage onClose={vi.fn()} onOpenFullChat={onOpenFullChat} />
        </QueryClientProvider>,
      );
    });
    await flush();

    // The earlier chat is no longer previewed inline: no message fetch happens
    // from this surface, and the button hands off to the (focused) full chat.
    const showEarlier = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Show earlier chat",
    );
    if (!showEarlier) throw new Error("Missing Show earlier chat button");
    await act(async () => {
      showEarlier.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(onOpenFullChat).toHaveBeenCalledWith("chat-1", { agentId: "asker-1", requestId: "request-1" });
    expect(chatMocks.listChatMessages).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  });
});
