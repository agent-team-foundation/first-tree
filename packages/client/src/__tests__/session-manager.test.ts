import type { InboxEntryWithMessage } from "@agent-team-foundation/first-tree-hub-shared";
import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext } from "../runtime/handler.js";
import { SessionManager, shouldSuppressEcho } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { recordingLogger, silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/** Create a mock SDK that satisfies FirstTreeHubSDK shape. */
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

/** Create a mock handler conforming to the new session-oriented interface. */
function createMockHandler(overrides?: Partial<AgentHandler>): AgentHandler {
  return {
    start: vi.fn().mockResolvedValue("session-id-mock"),
    resume: vi.fn().mockResolvedValue("session-id-mock"),
    inject: vi.fn(),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createSessionManager(opts: {
  sdk?: FirstTreeHubSDK;
  handler?: AgentHandler;
  session?: { idle_timeout: number; max_sessions: number; reconcile_interval_seconds: number };
  concurrency?: number;
  log?: pino.Logger;
}) {
  const handler = opts.handler ?? createMockHandler();
  const factory: HandlerFactory = () => handler;
  const sdk = opts.sdk ?? mockSdk();

  return new SessionManager({
    session: opts.session ?? { idle_timeout: 300, max_sessions: 10, reconcile_interval_seconds: 300 },
    concurrency: opts.concurrency ?? 5,
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
    log: opts.log ?? silentLogger(),
  });
}

describe("SessionManager", () => {
  it("creates a new session on first message to a chat", async () => {
    const handler = createMockHandler();
    const sm = createSessionManager({ handler });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));

    expect(handler.start).toHaveBeenCalledTimes(1);
    const calls = (handler.start as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, SessionContext];
    expect((calls[0] as { chatId: string }).chatId).toBe("chat-a");
    expect(calls[1].chatId).toBe("chat-a");

    await sm.shutdown();
  });

  it("ACKs inbox entry immediately on dispatch", async () => {
    const sdk = mockSdk();
    const sm = createSessionManager({ sdk });

    await sm.dispatch(mockEntry({ id: 42, chatId: "chat-1" }));

    expect(sdk.ack).toHaveBeenCalledWith(42);

    await sm.shutdown();
  });

  it("deduplicates messages with same message ID", async () => {
    const handler = createMockHandler();
    const sm = createSessionManager({ handler });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" })); // same messageId

    expect(handler.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("does NOT deduplicate same messageId delivered into different chats", async () => {
    // replyTo cross-chat routing legitimately produces two inbox_entries with
    // identical messageIds but different chatIds (one from fan-out, one from
    // replyTo routing). Dedup key must be (chatId, messageId), otherwise the
    // waiting chat's entry is silently dropped after the other copy arrives.
    const handlers: AgentHandler[] = [];
    const factory: HandlerFactory = () => {
      const h = createMockHandler();
      handlers.push(h);
      return h;
    };

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
    });

    const sharedMessageId = "msg-shared";
    await sm.dispatch(mockEntry({ id: 10, chatId: "chat-a", messageId: sharedMessageId }));
    await sm.dispatch(mockEntry({ id: 11, chatId: "chat-b", messageId: sharedMessageId }));

    expect(handlers).toHaveLength(2);
    expect(handlers[0]?.start).toHaveBeenCalledTimes(1);
    expect(handlers[1]?.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("still deduplicates genuine redelivery within the same chat", async () => {
    // Counterpart to the cross-chat test: within a single chat, at-least-once
    // delivery must still be idempotent. Two entries with same (chatId,
    // messageId) but different inbox entry ids must collapse to one handler
    // invocation.
    const handler = createMockHandler();
    const sm = createSessionManager({ handler });

    await sm.dispatch(mockEntry({ id: 20, chatId: "chat-x", messageId: "msg-redeliver" }));
    await sm.dispatch(mockEntry({ id: 21, chatId: "chat-x", messageId: "msg-redeliver" }));

    expect(handler.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("injects message into active session", async () => {
    const handler = createMockHandler();
    const sm = createSessionManager({ handler });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-1" }));

    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(handler.inject).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("creates separate sessions for different chats", async () => {
    const handlers: AgentHandler[] = [];
    const factory: HandlerFactory = () => {
      const h = createMockHandler();
      handlers.push(h);
      return h;
    };

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    expect(handlers).toHaveLength(2);
    expect(handlers[0]?.start).toHaveBeenCalledTimes(1);
    expect(handlers[1]?.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("calls handler.shutdown on session manager shutdown", async () => {
    const handler = createMockHandler();
    const sm = createSessionManager({ handler });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.shutdown();

    expect(handler.shutdown).toHaveBeenCalledTimes(1);
  });

  it("passes SessionContext with chatId and touch()", async () => {
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return "session-id";
      },
    });

    const sdk = mockSdk();
    const sm = createSessionManager({ handler, sdk });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.chatId).toBe("chat-1");
    expect(capturedCtx?.agent.agentId).toBe("agent-1");
    expect(typeof capturedCtx?.touch).toBe("function");
    expect(typeof capturedCtx?.log).toBe("function");
    expect(capturedCtx?.sdk).toBe(sdk);

    await sm.shutdown();
  });

  it("catches handler start errors without crashing", async () => {
    const { logger, records } = recordingLogger();
    const handler = createMockHandler({
      async start() {
        throw new Error("start boom");
      },
    });

    const sm = createSessionManager({ handler, log: logger });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    expect(records.some((r) => typeof r.msg === "string" && r.msg.includes("start/resume failed"))).toBe(true);

    await sm.shutdown();
  });

  it("evicts LRU session when max_sessions is reached", async () => {
    const handlers: AgentHandler[] = [];
    const factory: HandlerFactory = () => {
      const h = createMockHandler();
      handlers.push(h);
      return h;
    };

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 2, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-2" }));
    expect(sm.totalCount).toBe(2);

    // Third chat should evict the oldest
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-3" }));
    expect(sm.totalCount).toBe(2);

    await sm.shutdown();
  });

  it("resumes evicted session when new message arrives for same chat", async () => {
    const lifecycleCalls: Array<{ type: string; chatId: string; sessionId?: string }> = [];
    const factory: HandlerFactory = () =>
      createMockHandler({
        async start(msg) {
          const sid = `session-${msg.chatId}`;
          lifecycleCalls.push({ type: "start", chatId: msg.chatId });
          return sid;
        },
        async resume(msg, sessionId) {
          lifecycleCalls.push({ type: "resume", chatId: msg?.chatId ?? "", sessionId });
          return sessionId;
        },
      });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 2, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
    });

    // Fill up max_sessions
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-2" }));
    expect(sm.totalCount).toBe(2);

    // Third chat evicts chat-1 (LRU)
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-3" }));
    expect(sm.totalCount).toBe(2);

    // Fourth chat evicts chat-2
    await sm.dispatch(mockEntry({ id: 4, chatId: "chat-4" }));
    expect(sm.totalCount).toBe(2);

    // Now send a message to evicted chat-1 — should resume, not start
    await sm.dispatch(mockEntry({ id: 5, chatId: "chat-1" }));

    const chat1Events = lifecycleCalls.filter((e) => e.chatId === "chat-1");
    expect(chat1Events).toHaveLength(2);
    expect(chat1Events[0]?.type).toBe("start");
    expect(chat1Events[1]?.type).toBe("resume");
    expect(chat1Events[1]?.sessionId).toBe("session-chat-1");

    await sm.shutdown();
  });

  it("enforces concurrency limit and queues overflow", async () => {
    const startCalls: string[] = [];
    const factory: HandlerFactory = () =>
      createMockHandler({
        async start(msg) {
          startCalls.push(msg.chatId);
          return `session-${msg.chatId}`;
        },
      });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10, reconcile_interval_seconds: 300 },
      concurrency: 2,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-2" }));
    // Third dispatch hits concurrency limit — should preempt oldest idle
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-3" }));

    // All three should eventually have been started (one preempted)
    expect(startCalls).toContain("chat-1");
    expect(startCalls).toContain("chat-2");
    expect(startCalls).toContain("chat-3");

    await sm.shutdown();
  });
});

/**
 * Pure-function tests for the two routing guards added in proposals/
 * hub-agent-messaging-reply-and-mentions §3.5. Each branch of the decision
 * tree is pinned so a later refactor can't silently widen suppression.
 */
describe("shouldSuppressEcho", () => {
  const ME = "agent-me";
  function entry(over: Partial<InboxEntryWithMessage["message"]> & { chatId?: string }): InboxEntryWithMessage {
    const base = mockEntry({ chatId: over.chatId ?? "c2" });
    base.message = { ...base.message, ...over };
    return base;
  }

  it("returns false when the message is not a reply (no snapshot)", () => {
    expect(shouldSuppressEcho(entry({ inReplyToSnapshot: null }), ME)).toBe(false);
  });

  it("returns false when the original sender wasn't us", () => {
    const e = entry({
      inReplyTo: "M1",
      inReplyToSnapshot: { senderId: "agent-other", chatId: "c2", replyToChat: "c1" },
    });
    expect(shouldSuppressEcho(e, ME)).toBe(false);
  });

  it("returns false when the original was posted in a different chat than this entry", () => {
    // Case A — replyTo-routed copy: entry.chatId=c1, M1.chatId=c2 ≠ c1 → keep session (c1 should wake).
    const e = entry({
      chatId: "c1",
      inReplyTo: "M1",
      inReplyToSnapshot: { senderId: ME, chatId: "c2", replyToChat: "c1" },
    });
    expect(shouldSuppressEcho(e, ME)).toBe(false);
  });

  it("returns false when the original's replyTo points at this same chat (Case B — open chat here)", () => {
    // b1 started the conversation in c2 itself, so echoes in c2 are legit
    // continuations — suppression must NOT fire.
    const e = entry({
      chatId: "c2",
      inReplyTo: "M1",
      inReplyToSnapshot: { senderId: ME, chatId: "c2", replyToChat: "c2" },
    });
    expect(shouldSuppressEcho(e, ME)).toBe(false);
  });

  it("returns false when the original has no replyTo target at all", () => {
    const e = entry({
      chatId: "c2",
      inReplyTo: "M1",
      inReplyToSnapshot: { senderId: ME, chatId: "c2", replyToChat: null },
    });
    expect(shouldSuppressEcho(e, ME)).toBe(false);
  });

  it("returns true for the Case A fan-out copy (me + same chat + replyTo elsewhere)", () => {
    // This is the exact shape that used to cause the echo loop.
    const e = entry({
      chatId: "c2",
      inReplyTo: "M1",
      inReplyToSnapshot: { senderId: ME, chatId: "c2", replyToChat: "c1" },
    });
    expect(shouldSuppressEcho(e, ME)).toBe(true);
  });
});

/**
 * Integration: dispatch must ACK-and-drop when the echo guard fires — the
 * handler must never start a session for those entries. Mention-only
 * filtering has moved server-side (see services/message.ts fan-out), so the
 * client's only remaining routing guard is echo suppression.
 */
describe("SessionManager routing guards — dispatch integration", () => {
  it("ACKs and does NOT start a session when shouldSuppressEcho fires", async () => {
    const handler = createMockHandler();
    const sdk = mockSdk();
    const sm = createSessionManager({ handler, sdk });

    const echo = mockEntry({
      id: 99,
      chatId: "c2",
      inReplyTo: "M1",
      inReplyToSnapshot: { senderId: "agent-1", chatId: "c2", replyToChat: "c1" },
    });
    await sm.dispatch(echo);

    expect(handler.start).not.toHaveBeenCalled();
    expect(sdk.ack).toHaveBeenCalledWith(99);

    await sm.shutdown();
  });

  it("starts a session for any mention_only entry that reaches dispatch — server already filtered", async () => {
    // The server's fan-out only writes an inbox_entry for a mention_only
    // participant if they were in `metadata.mentions`; anything that reaches
    // the client is, by construction, for us. This test pins that the
    // client does NOT double-filter (no silent drops that would mask server
    // routing bugs, no skipping of legitimate mention deliveries).
    const handler = createMockHandler();
    const sdk = mockSdk();
    const sm = createSessionManager({ handler, sdk });

    const pinged = mockEntry({
      id: 101,
      chatId: "grp-2",
      recipientMode: "mention_only",
      metadata: { mentions: ["agent-1"] },
    });
    await sm.dispatch(pinged);

    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(sdk.ack).toHaveBeenCalledWith(101);

    await sm.shutdown();
  });

  it("still starts a session for replyTo-routed entry in the waiting chat (not suppressed)", async () => {
    // Case A: this is the entry with chatId=c1 (the original sender's waiting chat).
    // Snapshot says the original lived in c2, so shouldSuppressEcho returns false.
    const handler = createMockHandler();
    const sm = createSessionManager({ handler });

    const wake = mockEntry({
      id: 102,
      chatId: "c1",
      inReplyTo: "M1",
      inReplyToSnapshot: { senderId: "agent-1", chatId: "c2", replyToChat: "c1" },
    });
    await sm.dispatch(wake);

    expect(handler.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("suppresses the fan-out copy AND still dispatches the replyTo copy (Case A end-to-end)", async () => {
    // Simulates b1 receiving both copies of b2's reply: server fan-out creates
    // one inbox_entry with the original chatId=c2, and replyTo routing creates
    // a second entry with chatId=c1 — SAME messageId, different chatIds. The
    // c2 copy must be silently dropped (echo suppression) while the c1 copy
    // wakes the waiting session. This is the core No-echo invariant.
    const handler = createMockHandler();
    const sdk = mockSdk();
    const sm = createSessionManager({ handler, sdk });

    const snapshot = { senderId: "agent-1", chatId: "c2", replyToChat: "c1" };
    const sharedMessageId = "msg-shared-reply";
    const fanOut = mockEntry({
      id: 201,
      chatId: "c2",
      messageId: sharedMessageId,
      inReplyTo: "M1",
      inReplyToSnapshot: snapshot,
    });
    const replyRouted = mockEntry({
      id: 202,
      chatId: "c1",
      messageId: sharedMessageId,
      inReplyTo: "M1",
      inReplyToSnapshot: snapshot,
    });

    await sm.dispatch(fanOut);
    await sm.dispatch(replyRouted);

    expect(handler.start).toHaveBeenCalledTimes(1);
    const startArg = (handler.start as ReturnType<typeof vi.fn>).mock.calls[0];
    const firstArg = startArg?.[0] as { chatId?: string } | undefined;
    expect(firstArg?.chatId).toBe("c1");
    expect(sdk.ack).toHaveBeenCalledWith(201);
    expect(sdk.ack).toHaveBeenCalledWith(202);

    await sm.shutdown();
  });
});
