import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
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
  session?: { idle_timeout: number; max_sessions: number };
  concurrency?: number;
  log?: (msg: string) => void;
}) {
  const handler = opts.handler ?? createMockHandler();
  const factory: HandlerFactory = () => handler;
  const sdk = opts.sdk ?? mockSdk();

  return new SessionManager({
    session: opts.session ?? { idle_timeout: 300, max_sessions: 10 },
    concurrency: opts.concurrency ?? 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test" },
    agentIdentity: {
      agentId: "agent-1",
      displayName: "Agent",
      type: "autonomous_agent",
      delegateMention: null,
      profile: null,
      metadata: {},
    },
    sdk,
    log: opts.log ?? (() => {}),
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
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk,
      log: () => {},
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
    const logs: string[] = [];
    const handler = createMockHandler({
      async start() {
        throw new Error("start boom");
      },
    });

    const sm = createSessionManager({ handler, log: (msg) => logs.push(msg) });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    expect(logs.some((l) => l.includes("start failed"))).toBe(true);

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
      session: { idle_timeout: 300, max_sessions: 2 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk,
      log: () => {},
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
          lifecycleCalls.push({ type: "resume", chatId: msg.chatId, sessionId });
          return sessionId;
        },
      });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 2 },
      concurrency: 5,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk,
      log: () => {},
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
      session: { idle_timeout: 300, max_sessions: 10 },
      concurrency: 2,
      handlerFactory: factory,
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        displayName: null,
        type: "autonomous_agent",
        delegateMention: null,
        profile: null,
        metadata: {},
      },
      sdk,
      log: () => {},
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
