import type { AgentRuntimeConfig } from "@first-tree/shared";
import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { AgentHandler, HandlerFactory, SessionContext } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { recordingLogger, silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/** Create a mock SDK that satisfies FirstTreeHubSDK shape. */
function mockSdk(): FirstTreeHubSDK {
  return {
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
  } as unknown as FirstTreeHubSDK;
}

/** Create a vi-mocked WS ack callback for SessionManager tests. */
function mockAckEntry() {
  return vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  ackEntry?: (entryId: number) => Promise<void>;
  session?: {
    idle_timeout: number;
    max_sessions: number;
    working_grace_seconds: number;
    reconcile_interval_seconds: number;
  };
  concurrency?: number;
  log?: pino.Logger;
  agentConfigCache?: AgentConfigCache;
}) {
  const handler = opts.handler ?? createMockHandler();
  const factory: HandlerFactory = () => handler;
  const sdk = opts.sdk ?? mockSdk();

  return new SessionManager({
    session: opts.session ?? {
      idle_timeout: 300,
      max_sessions: 10,
      working_grace_seconds: 3600,
      reconcile_interval_seconds: 300,
    },
    concurrency: opts.concurrency ?? 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk,
    log: opts.log ?? silentLogger(),
    ackEntry: opts.ackEntry ?? mockAckEntry(),
    agentConfigCache: opts.agentConfigCache,
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

  it("does NOT ack on dispatch — entry is held until the handler calls markCompleted (in-flight recovery)", async () => {
    // Post-inflight-message-recovery: dispatch only enqueues the entry into
    // `inFlightEntries`. The ack waits for the handler to signal turn
    // completion via `ctx.markCompleted()`. A bare-mocked handler never
    // closes the turn, so no ack is fired.
    const ackEntry = mockAckEntry();
    const sm = createSessionManager({ ackEntry });

    await sm.dispatch(mockEntry({ id: 42, chatId: "chat-1" }));

    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("acks via the callback when the handler calls ctx.markCompleted()", async () => {
    // A handler that completes its turn cleanly drains the in-flight queue.
    const ackEntry = mockAckEntry();
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return "session-id-mock";
      },
    });
    const sm = createSessionManager({ ackEntry, handler });

    await sm.dispatch(mockEntry({ id: 42, chatId: "chat-1" }));
    expect(ackEntry).not.toHaveBeenCalled();

    // Handler closes the turn — this is what claude-code / codex do after
    // forwardResult success.
    expect(capturedCtx).not.toBeNull();
    capturedCtx?.markCompleted();
    // Drain is fire-and-forget — yield once so the ackEntry promise settles.
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledWith(42);

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
    // Defensive dedup-key shape. Cross-chat reply routing has been removed
    // (first-tree-context PR #281) so the production fan-out now produces
    // one entry per (inbox, message), but the client still keys dedup by
    // (chatId, messageId) to match the server-side identity tuple and to
    // survive any legacy entry / future fan-out variant.
    const handlers: AgentHandler[] = [];
    const factory: HandlerFactory = () => {
      const h = createMockHandler();
      handlers.push(h);
      return h;
    };

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry: mockAckEntry(),
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
    // Counterpart to the cross-chat-key test above: within a single chat,
    // at-least-once delivery of the same active entry must still be
    // idempotent.
    const handler = createMockHandler();
    const sm = createSessionManager({ handler });

    await sm.dispatch(mockEntry({ id: 20, chatId: "chat-x", messageId: "msg-redeliver" }));
    await sm.dispatch(mockEntry({ id: 20, chatId: "chat-x", messageId: "msg-redeliver" }));

    expect(handler.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("does NOT re-ack a dedup-hit while the entry is still in-flight (handler hasn't markCompleted yet)", async () => {
    // The first dispatch creates the in-flight slot; the second dispatch
    // (same chatId+messageId, same entryId — what `agent:bind` reset +
    // drainBacklog produces while a turn is still mid-flight) must NOT
    // ack — that would defuse inflight-message-recovery if this process
    // crashed mid-turn. The eventual `markCompleted` is the only thing
    // that should ack while the turn is open.
    const ackEntry = mockAckEntry();
    const handler = createMockHandler();
    const sm = createSessionManager({ ackEntry, handler });

    await sm.dispatch(mockEntry({ id: 50, chatId: "chat-mid", messageId: "msg-mid" }));
    await sm.dispatch(mockEntry({ id: 50, chatId: "chat-mid", messageId: "msg-mid" }));

    // Second dispatch is a dedup-hit, but the entry is still in inFlightEntries
    // (handler never called markCompleted in this test), so re-ack must be skipped.
    expect(ackEntry).not.toHaveBeenCalled();
    expect(handler.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("does NOT re-ack a dedup-hit whose chat was LRU-evicted — the bind-reset recovery path must stay open", async () => {
    // R5 boundary: LRU eviction removes the entry from `inFlightEntries`
    // WITHOUT acking it (no handler will ever fire markCompleted). The
    // recovery contract documented in `evictIfNeeded` is "server's
    // bind-reset redelivers against a fresh session." Pre-this-PR the
    // dispatch dedup short-circuit silently returned, the evicted chat's
    // dedup key kept the redelivery from being mis-classified as a fresh
    // message at process restart, and recovery worked. After adding the
    // dedup-hit re-ack the path would have been broken: dedup-hit + entry
    // not in-flight → re-ack → server marks acked → no redelivery → loss.
    // The fix synchronously drops the evicted chat's dedup keys, so the
    // redelivery is no longer a dedup hit at all and goes through the
    // normal `startNewSession` (with evictedMappings → handler.resume)
    // path. Verifies (1) ack is NOT called for the evicted entry on
    // redelivery, and (2) the handler runs again (fresh session pickup).
    const ackEntry = mockAckEntry();
    const startSpy = vi.fn(async (_msg: unknown, _ctx: SessionContext) => "session-id-mock");
    const resumeSpy = vi.fn(async (_msg: unknown, _sid: string, _ctx: SessionContext) => "session-id-mock");
    const handler = createMockHandler({ start: startSpy, resume: resumeSpy });
    const sm = createSessionManager({
      ackEntry,
      handler,
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    });

    // Fill the session pool: chat-a then chat-b. chat-a becomes LRU.
    await sm.dispatch(mockEntry({ id: 70, chatId: "chat-a", messageId: "msg-a" }));
    await sm.dispatch(mockEntry({ id: 71, chatId: "chat-b", messageId: "msg-b" }));
    expect(startSpy).toHaveBeenCalledTimes(2);

    // chat-c trips evictIfNeeded — sessions.size (2) >= max_sessions (2),
    // chat-a is the LRU candidate and gets evicted (chat-a:msg-a should
    // come out of the dedup set as part of eviction).
    await sm.dispatch(mockEntry({ id: 72, chatId: "chat-c", messageId: "msg-c" }));
    expect(startSpy).toHaveBeenCalledTimes(3);
    // Nothing has been acked yet — none of the mock handlers call markCompleted.
    expect(ackEntry).not.toHaveBeenCalled();

    // Simulate server-side bind-reset redelivery of the SAME entry for
    // the LRU-evicted chat. The bind event clears the local recovery guard;
    // if the dedup key were still around this
    // would dedup-hit and (post-#1-fix) get re-acked, shortcutting
    // recovery. With the dedup key dropped at eviction time, the entry
    // routes normally through startNewSession → handler.resume against
    // the saved evictedMappings.
    sm.noteBindRecoveryComplete();
    await sm.dispatch(mockEntry({ id: 70, chatId: "chat-a", messageId: "msg-a" }));

    // Recovery path: handler.resume invoked once for chat-a (it was
    // evicted, so the new dispatch resumes from evictedMappings).
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    // Critically: NO ack for the evicted entry. The fresh session will
    // ack it when its handler calls markCompleted at turn end.
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("drops dedup after completion so ack-lost redelivery re-enters the handler instead of re-acking", async () => {
    const ackEntry = mockAckEntry();
    let capturedCtx: SessionContext | undefined;
    const startSpy = vi.fn(async (_msg: unknown, ctx: SessionContext) => {
      capturedCtx = ctx;
      return "session-id-mock";
    });
    const injectSpy = vi.fn();
    const handler = createMockHandler({ start: startSpy, inject: injectSpy });
    const sm = createSessionManager({ ackEntry, handler });

    // Turn 1: original delivery.
    await sm.dispatch(mockEntry({ id: 60, chatId: "chat-redeliver", messageId: "msg-redeliver" }));
    capturedCtx?.markCompleted();
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenLastCalledWith(60);

    // Simulate server-side bind-reset redelivery of the same entryId after
    // the original ack went missing. The completed entry's dedup key was
    // dropped when ack-through was sent, so this is treated as at-least-once
    // redelivery and re-enters the active handler instead of sending a
    // standalone re-ack from the dedup branch.
    await sm.dispatch(mockEntry({ id: 60, chatId: "chat-redeliver", messageId: "msg-redeliver" }));

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledTimes(1);

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
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry: mockAckEntry(),
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
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry: mockAckEntry(),
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
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry: mockAckEntry(),
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

    // Simulate the next agent:bind reset before redelivery into an evicted
    // chat. Until that happens the runtime blocks the chat to avoid
    // ack-through committing abandoned delivered entries.
    sm.noteBindRecoveryComplete();
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
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 2,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "test-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry: mockAckEntry(),
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
 * Mention-only filtering lives on the server (see services/message.ts
 * fan-out). With cross-chat reply routing removed (see
 * first-tree-context PR #281), the client has no remaining routing
 * guard — any entry that reaches dispatch must dispatch.
 */
describe("SessionManager dispatch integration", () => {
  it("starts a session for any mention_only entry that reaches dispatch — server already filtered", async () => {
    // The server's fan-out only writes an inbox_entry for a mention_only
    // participant if they were in `metadata.mentions`; anything that reaches
    // the client is, by construction, for us. This test pins that the
    // client does NOT double-filter (no silent drops that would mask server
    // routing bugs, no skipping of legitimate mention deliveries).
    //
    // Post-inflight-message-recovery: dispatch starts the handler but does
    // NOT ack immediately; ack happens once the handler calls
    // `ctx.markCompleted()`. We close the turn here to exercise both
    // halves of the contract.
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler();
    const startSpy = handler.start as ReturnType<typeof vi.fn>;
    startSpy.mockImplementation(async (_msg: unknown, ctx: SessionContext) => {
      capturedCtx = ctx;
      return "session-id-mock";
    });
    const ackEntry = mockAckEntry();
    const sm = createSessionManager({ handler, ackEntry });

    const pinged = mockEntry({
      id: 101,
      chatId: "grp-2",
      recipientMode: "mention_only",
      metadata: { mentions: ["agent-1"] },
    });
    await sm.dispatch(pinged);

    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalled();

    capturedCtx?.markCompleted();
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledWith(101);

    await sm.shutdown();
  });
});

/**
 * `ackEntry` is the WS data-plane ack callback wired from AgentSlot to
 * `clientConnection.sendInboxAck`. Post-inflight-message-recovery the
 * runtime defers acks: every entry sits in `inFlightEntries[chatId]` until
 * the handler calls `ctx.markCompleted()`, the runtime drains the queue
 * during a permanent failure / terminate teardown, or the next
 * `agent:bind` resets it server-side. Tests below pin the deferred-ack
 * contract for each entry-point dispatch can hit.
 */
describe("SessionManager ackEntry callback (deferred ack)", () => {
  function buildSm(ackEntry: (entryId: number) => Promise<void>, handler?: AgentHandler) {
    const h = handler ?? createMockHandler();
    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: () => h,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
    });
    return { sm, handler: h };
  }

  it("ack waits for markCompleted when starting a new session", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(_m, ctx) {
        capturedCtx = ctx;
        return "session-id-mock";
      },
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    expect(ackEntry).not.toHaveBeenCalled();

    capturedCtx?.markCompleted();
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(1);

    await sm.shutdown();
  });

  it("markMessagesCompleted(message) acks through the concrete consumed entry only", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const injected: Parameters<AgentHandler["inject"]>[0][] = [];
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      inject: vi.fn((m) => {
        injected.push(m);
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-1" }));

    expect(ackEntry).not.toHaveBeenCalled();

    // First turn closes — ack entry #1 only.
    if (firstMessage) capturedCtx?.markMessagesCompleted(firstMessage);
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(1);

    // Second turn closes — ack entry #2.
    if (injected[0]) capturedCtx?.markMessagesCompleted(injected[0]);
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(2);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 2);

    await sm.shutdown();
  });

  it("markMessagesCompleted(batch) sends one ack-through for the batch tail", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const injected: Parameters<AgentHandler["inject"]>[0][] = [];
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      inject: vi.fn((m) => {
        injected.push(m);
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 10, chatId: "chat-codex" }));
    await sm.dispatch(mockEntry({ id: 11, chatId: "chat-codex" }));
    await sm.dispatch(mockEntry({ id: 12, chatId: "chat-codex" }));
    expect(ackEntry).not.toHaveBeenCalled();

    // First turn (just message 10).
    if (firstMessage) capturedCtx?.markMessagesCompleted(firstMessage);
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(10);

    // Fused turn (messages 11 + 12 batched into one runTurn).
    capturedCtx?.markMessagesCompleted(injected);
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(2);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 12);

    await sm.shutdown();
  });

  it("markMessagesCompleted ignores stale messages that are no longer tracked", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const handler = createMockHandler({
      async start(m, ctx) {
        capturedMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 20, chatId: "chat-clamp" }));
    if (capturedMessage) capturedCtx?.markMessagesCompleted(capturedMessage);
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(20);

    if (capturedMessage) capturedCtx?.markMessagesCompleted(capturedMessage);
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("serializes same-chat admission before routing later delivered frames", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const firstRefresh = deferred<AgentRuntimeConfig>();
    let refreshCalls = 0;
    const agentConfigCache: AgentConfigCache = {
      get: vi.fn(),
      refreshIfNewer: vi.fn(() => {
        refreshCalls++;
        return refreshCalls === 1 ? firstRefresh.promise : Promise.resolve({} as AgentRuntimeConfig);
      }),
      refresh: vi.fn(async () => ({}) as AgentRuntimeConfig),
      updateUrls: vi.fn(),
      allReferencedUrls: vi.fn(() => new Set<string>()),
      forget: vi.fn(),
    };
    const routed: string[] = [];
    const injected: Parameters<AgentHandler["inject"]>[0][] = [];
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(m, ctx) {
        routed.push(`start:${m.id}`);
        capturedCtx = ctx;
        return "session-id-mock";
      },
      inject: vi.fn((m) => {
        routed.push(`inject:${m.id}`);
        injected.push(m);
      }),
    });
    const sm = createSessionManager({ ackEntry, handler, agentConfigCache });

    const firstDispatch = sm.dispatch(mockEntry({ id: 1, chatId: "chat-admit", messageId: "msg-a1" }));
    await vi.waitFor(() => expect(agentConfigCache.refreshIfNewer).toHaveBeenCalledTimes(1));

    const secondDispatch = sm.dispatch(mockEntry({ id: 2, chatId: "chat-admit", messageId: "msg-a2" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(routed).toEqual([]);
    expect(handler.inject).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    firstRefresh.resolve({} as AgentRuntimeConfig);
    await firstDispatch;
    await secondDispatch;

    expect(routed).toEqual(["start:msg-a1", "inject:msg-a2"]);
    expect(agentConfigCache.refreshIfNewer).toHaveBeenCalledTimes(2);

    if (injected[0]) capturedCtx?.markMessagesCompleted(injected[0]);
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(2);

    await sm.shutdown();
  });

  it("fails closed when routeMessage fails after an entry was marked admitted", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoveryStart = vi.fn(async () => "session-id-recovery");
    let factoryCalls = 0;
    const factory = vi.fn<HandlerFactory>(() => {
      factoryCalls++;
      if (factoryCalls === 1) throw new Error("handler factory offline");
      return createMockHandler({ start: recoveryStart });
    });
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: mockSdk(),
      log: silentLogger(),
      ackEntry,
    });

    await expect(sm.dispatch(mockEntry({ id: 1, chatId: "chat-route-fail", messageId: "msg-a1" }))).rejects.toThrow(
      "handler factory offline",
    );

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-route-fail", messageId: "msg-a2" }));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(recoveryStart).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("suspend abandons unfinished in-flight entries and blocks newer same-chat delivery until bind recovery", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    const resumeSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({
      async start(_m, ctx) {
        capturedCtx = ctx;
        return "session-id-mock";
      },
      resume: resumeSpy,
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 30, chatId: "chat-suspend", messageId: "msg-a1" }));
    await sm.handleCommand("chat-suspend", "session:suspend");
    await sm.dispatch(mockEntry({ id: 31, chatId: "chat-suspend", messageId: "msg-a2" }));

    capturedCtx?.markCompleted();
    await Promise.resolve();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("retryable attempt abandonment prevents a later queued message from acking through the old entry", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const injected: Parameters<AgentHandler["inject"]>[0][] = [];
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      inject: vi.fn((m) => {
        injected.push(m);
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 40, chatId: "chat-retryable", messageId: "msg-a1" }));
    await sm.dispatch(mockEntry({ id: 41, chatId: "chat-retryable", messageId: "msg-a2" }));

    if (firstMessage) capturedCtx?.markMessagesRetryable(firstMessage, "turn_timeout");
    if (injected[0]) capturedCtx?.markMessagesCompleted(injected[0]);
    await Promise.resolve();

    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("ack waits for markCompleted when resuming an evicted session", async () => {
    // Seed an evicted session by exceeding concurrency=1, then dispatch into
    // the evicted chat to trigger the resume branch.
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const capturedCtxs: SessionContext[] = [];
    const handler = createMockHandler({
      async start(_m, ctx) {
        capturedCtxs.push(ctx);
        return "session-id-mock";
      },
      async resume(_m, _sid, ctx) {
        capturedCtxs.push(ctx);
        return "session-id-mock";
      },
    });
    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 1, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 1,
      handlerFactory: () => handler,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
    });

    // Start chat-a, then chat-b which evicts chat-a (max_sessions=1).
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // Close chat-a and chat-b's start turns so their entries don't pollute
    // the resume-branch ack assertion.
    capturedCtxs[0]?.markCompleted();
    capturedCtxs[1]?.markCompleted();
    await Promise.resolve();
    ackEntry.mockClear();

    // Dispatching back into chat-a after bind reset hits the resume branch.
    sm.noteBindRecoveryComplete();
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-a", messageId: "msg-resume" }));
    expect(ackEntry).not.toHaveBeenCalled();

    capturedCtxs[2]?.markCompleted();
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledWith(3);

    await sm.shutdown();
  });

  it("acks on permanent handler.start failure so a permanent error doesn't loop on redelivery", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    // Error class name is what `classify` keys on for the permanent
    // `client_identity_mismatch` path (see runtime/error-taxonomy.ts:219).
    class ClientUserMismatchError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ClientUserMismatchError";
      }
    }
    const handler = createMockHandler({
      start: vi.fn(async () => {
        throw new ClientUserMismatchError("permanent identity rejection");
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 7, chatId: "chat-perm" }));
    // Two microtask yields: classify + handleSessionFailure both schedule
    // event-emit + ack on the queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledWith(7);

    await sm.shutdown();
  });

  it("does NOT ack on transient handler.start failure — retry path keeps the entry queued for forwardResult", async () => {
    // A 429-ish error is classified as transient; the runtime schedules a
    // retry inside `handleSessionFailure` and leaves the entry queued so
    // the eventual successful retry can ack it via markCompleted.
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const transientErr = Object.assign(new Error("rate limited"), { status: 429 });
    const handler = createMockHandler({
      start: vi.fn(async () => {
        throw transientErr;
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 8, chatId: "chat-tr" }));
    await Promise.resolve();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("acks queued in-flight entries on session:terminate", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    // Handler whose `start` resolves quickly (matching production: start
    // returns the sessionId; the turn closes later via markCompleted).
    // markCompleted is NEVER called by this mock, so the entry sits in
    // `inFlightEntries` past the turn — exactly what terminate needs to
    // ack so the next bind doesn't redeliver.
    const handler = createMockHandler();
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 11, chatId: "chat-term" }));
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.handleCommand("chat-term", "session:terminate");
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledWith(11);

    await sm.shutdown();
  });
});
