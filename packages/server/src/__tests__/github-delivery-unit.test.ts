import type { NormalizedScmEvent } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubProviderTaskContext } from "../services/github-audience.js";
import type { ScmAudienceTarget } from "../services/scm-audience-composition.js";

type MockFn = ReturnType<typeof vi.fn>;

type MockBag = {
  refreshGithubChatTopic: MockFn;
  resolveGithubExistingLineChat: MockFn;
  resolveTargetChat: MockFn;
  applyMembershipWrite: MockFn;
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

type TargetOverrides = {
  humanAgentId: string;
  delegateAgentId: string;
  chatId: string;
  involveReason: "review_requested" | "mentioned" | "assigned" | null;
  involveLogin: string | null;
};

function existingTarget(overrides: Partial<TargetOverrides> = {}): ScmAudienceTarget<GithubProviderTaskContext> {
  const humanAgentId = overrides.humanAgentId ?? "human-1";
  const delegateAgentId = overrides.delegateAgentId ?? "delegate-1";
  const chatId = overrides.chatId ?? "chat-1";
  const involveReason = overrides.involveReason ?? null;
  const involveLogin = overrides.involveLogin ?? null;
  return {
    entry: {
      kind: "existing_line",
      line: {
        kind: "attention_line",
        humanAgentId,
        wakeAgentId: delegateAgentId,
        chatId,
        provenance: "identity_target",
      },
    },
    ...(involveReason && involveLogin
      ? {
          directedContext: {
            reason: involveReason,
            requiresPersistentLine: involveReason === "mentioned" || involveReason === "assigned",
            externalUsername: involveLogin,
          },
        }
      : {}),
  };
}

function newTarget(overrides: Partial<TargetOverrides> = {}): ScmAudienceTarget<GithubProviderTaskContext> {
  return {
    entry: {
      kind: "personnel_target",
      humanAgentId: overrides.humanAgentId ?? "human-1",
      wakeAgentId: overrides.delegateAgentId ?? "delegate-1",
      reason: overrides.involveReason ?? "mentioned",
      requiresPersistentLine:
        overrides.involveReason === undefined ||
        overrides.involveReason === "mentioned" ||
        overrides.involveReason === "assigned",
      externalUsername: overrides.involveLogin ?? "alice",
    },
  };
}

function providerTaskTarget(): ScmAudienceTarget<GithubProviderTaskContext> {
  return {
    entry: {
      kind: "provider_task_target",
      humanAgentId: "human-task",
      wakeAgentId: "delegate-task",
      providerContext: { kind: "github_app_task", agentUuid: "delegate-task" },
    },
  };
}

async function loadDelivery(overrides: Partial<MockBag> = {}): Promise<{
  deliverGithubEvent: typeof import("../services/github-delivery.js").deliverGithubEvent;
  mocks: MockBag;
}> {
  vi.resetModules();

  const mocks: MockBag = {
    refreshGithubChatTopic: vi.fn(async () => undefined),
    resolveGithubExistingLineChat: vi.fn(async () => ({ chatId: "chat-existing", created: false })),
    resolveTargetChat: vi.fn(async () => ({ chatId: "chat-created", created: true, boundVia: "direct" })),
    applyMembershipWrite: vi.fn(async () => undefined),
    setEntityTitle: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ message: { id: "message-1" }, recipients: ["recipient-1"] })),
    notifyRecipients: vi.fn(),
    ...overrides,
  };

  vi.doMock("../services/github-entity-chat.js", () => ({
    refreshGithubChatTopic: mocks.refreshGithubChatTopic,
    resolveGithubExistingLineChat: mocks.resolveGithubExistingLineChat,
    resolveGithubPersonnelTargetChat: mocks.resolveTargetChat,
    resolveTargetChat: mocks.resolveTargetChat,
  }));
  vi.doMock("../services/github-entity-state.js", () => ({
    setEntityTitle: mocks.setEntityTitle,
  }));
  vi.doMock("../services/participant-mode.js", () => ({
    applyMembershipWrite: mocks.applyMembershipWrite,
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
  vi.doUnmock("../services/participant-mode.js");
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
    const resolveGithubExistingLineChat = vi.fn(async () => ({ chatId: "chat-shared", created: false }));
    const { deliverGithubEvent, mocks } = await loadDelivery({
      resolveTargetChat,
      resolveGithubExistingLineChat,
      sendMessage,
      setEntityTitle,
    });

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

  it("uses the surface URL consistently for task card and publisher provenance when the entity URL is absent", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const sendMessage = vi.fn(async (_db: unknown, _chatId: string, _senderId: string, payload: unknown) => {
      sentPayloads.push(payload as Record<string, unknown>);
      return { message: { id: "message-fallback-url" }, recipients: ["recipient-fallback-url"] };
    });
    const { deliverGithubEvent } = await loadDelivery({ sendMessage });
    const event = makeEvent();
    event.entity.url = undefined;
    event.surface.url = "https://github.com/owner/repo/pull/1";

    const stats = await deliverGithubEvent(makeApp(), event, [providerTaskTarget()]);

    expect(stats).toEqual({ delivered: 1, newChats: 1, failed: 0 });
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({
      content: {
        entity: { url: "https://github.com/owner/repo/pull/1" },
        teamAgentTask: { agentUuid: "delegate-task", runId: expect.any(String) },
      },
      metadata: {
        githubTaskEntityUrl: "https://github.com/owner/repo/pull/1",
        githubTaskRun: true,
        teamAgentTask: { agentUuid: "delegate-task", runId: expect.any(String) },
      },
    });
  });

  it("isolates a per-chat delivery failure and continues with later chats", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce("send failed")
      .mockResolvedValueOnce({ message: { id: "message-ok" }, recipients: ["recipient-ok"] });
    const resolveGithubExistingLineChat = vi.fn(async (_db: unknown, input: { humanAgentId: string }) => ({
      chatId: input.humanAgentId === "human-a" ? "chat-a" : "chat-b",
      created: false,
    }));
    const { deliverGithubEvent, mocks } = await loadDelivery({ sendMessage, resolveGithubExistingLineChat });

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
