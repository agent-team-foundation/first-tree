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

function createSessionManager(
  handler: AgentHandler,
  sdk: FirstTreeHubSDK,
  ackEntry: (entryId: number) => Promise<void>,
) {
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
    ackEntry,
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
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const sm = createSessionManager(handler, sdk, ackEntry);

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
    expect(ackEntry).toHaveBeenCalledWith(99);
    expect(handler.start).not.toHaveBeenCalled();
    expect(handler.resume).not.toHaveBeenCalled();
    expect(handler.inject).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("falls through to normal dispatch when no waiter is registered (stale answer after suspend)", async () => {
    const handler = createMockHandler();
    const sdk = mockSdk();
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const sm = createSessionManager(handler, sdk, ackEntry);

    await sm.dispatch(
      makeAnswerEntry({
        entryId: 100,
        chatId: "chat-stale",
        correlationId: "tu_unknown",
        answers: { q: "v" },
      }),
    );

    // No live waiter → SessionManager must NOT short-circuit. The answer
    // flows through normal dispatch so the suspended SDK can resume with
    // the answer as fresh user input. Verifies handler.start was called
    // (this chat had no prior session row, so dispatch creates one).
    expect(handler.start).toHaveBeenCalledTimes(1);
    // The handler's start ackEntry path eventually acks; we verify ack
    // happens at least once.
    expect(ackEntry).toHaveBeenCalledWith(100);

    await sm.shutdown();
  });
});
