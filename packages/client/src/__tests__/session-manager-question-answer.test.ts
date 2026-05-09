import type { InboxEntryWithMessage } from "@agent-team-foundation/first-tree-hub-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllPendingQuestionsForTest,
  pendingQuestionCount,
  registerPendingQuestion,
} from "../handlers/ask-user-bridge.js";
import type { AgentHandler, HandlerFactory } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";

/**
 * SessionManager.dispatch must short-circuit `format: "question_answer"`
 * entries: they are system-level signals that resolve a pending
 * `canUseTool` Promise rather than user-facing messages that should
 * start/wake an LLM session. Verifies:
 *   - matching answers resolve the bridge waiter
 *   - the inbox entry is acked even when no waiter exists (stale answer
 *     after handler shutdown — otherwise the row would sit forever)
 *   - the handler's start/resume/inject is never called for these messages
 */

function mockSdk(): FirstTreeHubSDK {
  return {
    register: vi.fn(),
    pull: vi.fn(),
    ack: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
  } as unknown as FirstTreeHubSDK;
}

function createMockHandler(): AgentHandler {
  return {
    start: vi.fn().mockResolvedValue("session-id-mock"),
    resume: vi.fn().mockResolvedValue("session-id-mock"),
    inject: vi.fn(),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function createSessionManager(handler: AgentHandler, sdk: FirstTreeHubSDK) {
  const factory: HandlerFactory = () => handler;
  return new SessionManager({
    session: { idle_timeout: 300, max_sessions: 10, reconcile_interval_seconds: 300 },
    concurrency: 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Agent",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    sdk,
    log: silentLogger(),
  });
}

function makeAnswerEntry(args: {
  entryId: number;
  chatId: string;
  correlationId: string;
  answers: Record<string, string>;
}): InboxEntryWithMessage {
  return {
    id: args.entryId,
    inboxId: "inbox-test",
    messageId: `msg-${args.entryId}`,
    chatId: args.chatId,
    status: "delivered",
    retryCount: 0,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    ackedAt: null,
    message: {
      id: `msg-${args.entryId}`,
      chatId: args.chatId,
      senderId: "sender-human",
      format: "question_answer",
      content: { correlationId: args.correlationId, answers: args.answers },
      metadata: {},
      replyToInbox: null,
      replyToChat: null,
      inReplyTo: null,
      source: null,
      createdAt: new Date().toISOString(),
      configVersion: 1,
      recipientMode: "full",
      inReplyToSnapshot: null,
      precedingMessages: [],
    },
  };
}

afterEach(() => {
  clearAllPendingQuestionsForTest();
});

describe("SessionManager.dispatch — question_answer short-circuit", () => {
  it("resolves the bridge waiter and acks the entry without invoking the handler", async () => {
    const handler = createMockHandler();
    const sdk = mockSdk();
    const sm = createSessionManager(handler, sdk);

    const waiter = registerPendingQuestion({
      correlationId: "tu_abc",
      agentId: "agent-1",
      chatId: "chat-1",
    });
    expect(pendingQuestionCount()).toBe(1);

    await sm.dispatch(
      makeAnswerEntry({
        entryId: 99,
        chatId: "chat-1",
        correlationId: "tu_abc",
        answers: { "Should I proceed?": "Yes" },
      }),
    );

    await expect(waiter).resolves.toEqual({
      status: "answered",
      answers: { "Should I proceed?": "Yes" },
    });
    expect(pendingQuestionCount()).toBe(0);
    expect(sdk.ack).toHaveBeenCalledWith(99);
    expect(handler.start).not.toHaveBeenCalled();
    expect(handler.resume).not.toHaveBeenCalled();
    expect(handler.inject).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("acks the entry even when no waiter is registered (stale answer)", async () => {
    const handler = createMockHandler();
    const sdk = mockSdk();
    const sm = createSessionManager(handler, sdk);

    await sm.dispatch(
      makeAnswerEntry({
        entryId: 100,
        chatId: "chat-1",
        correlationId: "tu_unknown",
        answers: { q: "v" },
      }),
    );

    expect(sdk.ack).toHaveBeenCalledWith(100);
    expect(handler.start).not.toHaveBeenCalled();

    await sm.shutdown();
  });
});
