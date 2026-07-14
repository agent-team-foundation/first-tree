import type { NormalizedScmEvent } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudienceTarget } from "../services/github-audience.js";

type MockFn = ReturnType<typeof vi.fn>;

type MockBag = {
  findReuseChatForInvolved: MockFn;
  refreshGithubChatTopic: MockFn;
  resolveTargetChat: MockFn;
  setEntityTitle: MockFn;
  sendMessage: MockFn;
  notifyRecipients: MockFn;
};

function makeEvent(overrides: Partial<NormalizedScmEvent> = {}): NormalizedScmEvent {
  return {
    provider: "github",
    source: { externalId: "installation:1", organizationId: "org-1" },
    stableDeliveryId: "delivery-1",
    ingressAuthority: "verified_signature",
    eventType: "pull_request",
    action: "opened",
    entity: {
      type: "pull_request",
      projectKey: "owner/repo",
      key: "owner/repo#1",
      title: "Refactor inbox",
      url: "https://github.com/owner/repo/pull/1",
    },
    actor: { externalUsername: "alice", isBot: false },
    kind: "opened",
    targets: [],
    surface: {
      title: "PR #1: Refactor inbox",
      body: "Body",
      url: "https://github.com/owner/repo/pull/1",
    },
    relatedRefs: [],
    ...overrides,
  };
}

function makeApp(): FastifyInstance {
  // The mocked collaborators only read `db` and `notifier`; the full Fastify
  // surface is irrelevant for these orchestration tests.
  return { db: { id: "db" }, notifier: { id: "notifier" } } as unknown as FastifyInstance;
}

function existingTarget(overrides: Partial<AudienceTarget> = {}): AudienceTarget {
  return {
    humanAgentId: "human-1",
    delegateAgentId: "delegate-1",
    kind: "existing",
    chatId: "chat-1",
    involveReason: null,
    involveLogin: null,
    ...overrides,
  };
}

function newTarget(overrides: Partial<AudienceTarget> = {}): AudienceTarget {
  return {
    humanAgentId: "human-1",
    delegateAgentId: "delegate-1",
    kind: "new",
    chatId: null,
    involveReason: "mentioned",
    involveLogin: "alice",
    ...overrides,
  };
}

async function loadDelivery(overrides: Partial<MockBag> = {}): Promise<{
  deliverGithubEvent: typeof import("../services/github-delivery.js").deliverGithubEvent;
  mocks: MockBag;
}> {
  vi.resetModules();

  const mocks: MockBag = {
    findReuseChatForInvolved: vi.fn(async () => null),
    refreshGithubChatTopic: vi.fn(async () => undefined),
    resolveTargetChat: vi.fn(async () => ({ chatId: "chat-created", created: true, boundVia: "direct" })),
    setEntityTitle: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ message: { id: "message-1" }, recipients: ["recipient-1"] })),
    notifyRecipients: vi.fn(),
    ...overrides,
  };

  vi.doMock("../services/github-entity-chat.js", () => ({
    findReuseChatForInvolved: mocks.findReuseChatForInvolved,
    refreshGithubChatTopic: mocks.refreshGithubChatTopic,
    resolveTargetChat: mocks.resolveTargetChat,
  }));
  vi.doMock("../services/github-entity-state.js", () => ({
    setEntityTitle: mocks.setEntityTitle,
  }));
  vi.doMock("../services/message.js", () => ({
    sendMessage: mocks.sendMessage,
  }));
  vi.doMock("../services/notifier.js", () => ({
    notifyRecipients: mocks.notifyRecipients,
  }));

  const { deliverGithubEvent } = await import("../services/github-delivery.js");
  return { deliverGithubEvent, mocks };
}

afterEach(() => {
  vi.doUnmock("../services/github-entity-chat.js");
  vi.doUnmock("../services/github-entity-state.js");
  vi.doUnmock("../services/message.js");
  vi.doUnmock("../services/notifier.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("deliverGithubEvent dependency edge paths", () => {
  it("drops a new target when chat resolution intentionally returns null", async () => {
    const resolveTargetChat = vi.fn(async () => null);
    const { deliverGithubEvent, mocks } = await loadDelivery({ resolveTargetChat });

    const stats = await deliverGithubEvent(makeApp(), makeEvent(), [
      newTarget({ humanAgentId: "human-new", delegateAgentId: "delegate-new" }),
    ]);

    expect(stats).toEqual({ delivered: 0, newChats: 0, failed: 0 });
    expect(resolveTargetChat).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.notifyRecipients).not.toHaveBeenCalled();
  });

  it("merges duplicate chat targets, keeps created status, and ranks involved reasons", async () => {
    const sentPayloads: unknown[] = [];
    const sendMessage = vi.fn(async (_db: unknown, _chatId: string, _senderId: string, payload: unknown) => {
      sentPayloads.push(payload);
      return { message: { id: "message-ranked" }, recipients: ["recipient-ranked"] };
    });
    const setEntityTitle = vi.fn(async () => {
      throw new Error("title store down");
    });
    const resolveTargetChat = vi.fn(async () => ({ chatId: "chat-shared", created: true, boundVia: "direct" }));
    const { deliverGithubEvent, mocks } = await loadDelivery({ resolveTargetChat, sendMessage, setEntityTitle });

    const stats = await deliverGithubEvent(makeApp(), makeEvent(), [
      existingTarget({
        humanAgentId: "human-b",
        delegateAgentId: "delegate-b",
        chatId: "chat-shared",
      }),
      newTarget({
        humanAgentId: "human-b",
        delegateAgentId: "delegate-b",
        involveReason: "assigned",
        involveLogin: "assigned-user",
      }),
      existingTarget({
        humanAgentId: "human-a",
        delegateAgentId: "delegate-a",
        chatId: "chat-shared",
        involveReason: "review_requested",
        involveLogin: "reviewer",
      }),
      existingTarget({
        humanAgentId: "human-c",
        delegateAgentId: "delegate-c",
        chatId: "chat-shared",
        involveReason: "mentioned",
        involveLogin: "mentioned-user",
      }),
    ]);

    expect(stats).toEqual({ delivered: 1, newChats: 1, failed: 0 });
    expect(setEntityTitle).toHaveBeenCalledTimes(1);
    expect(mocks.refreshGithubChatTopic).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.notifyRecipients).toHaveBeenCalledWith({ id: "notifier" }, ["recipient-ranked"], "message-ranked");
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({
      content: { reason: "review_requested", mentionedUser: "reviewer" },
      metadata: {
        reason: "review_requested",
        mentions: ["delegate-a", "delegate-b", "delegate-c"],
        mentionedUser: "reviewer",
      },
    });
  });

  it("isolates a per-chat delivery failure and continues with later chats", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce("send failed")
      .mockResolvedValueOnce({ message: { id: "message-ok" }, recipients: ["recipient-ok"] });
    const { deliverGithubEvent, mocks } = await loadDelivery({ sendMessage });

    const stats = await deliverGithubEvent(makeApp(), makeEvent({ action: "synchronize" }), [
      existingTarget({ humanAgentId: "human-a", delegateAgentId: "delegate-a", chatId: "chat-a" }),
      existingTarget({ humanAgentId: "human-b", delegateAgentId: "delegate-b", chatId: "chat-b" }),
    ]);

    expect(stats).toEqual({ delivered: 1, newChats: 0, failed: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.notifyRecipients).toHaveBeenCalledOnce();
    expect(mocks.notifyRecipients).toHaveBeenCalledWith({ id: "notifier" }, ["recipient-ok"], "message-ok");
  });
});
