import type { InboxEntryWithMessage } from "@agent-hub/shared";
import { describe, expect, it, vi } from "vitest";
import type { HandlerContext, HandlerFactory } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { AgentHubSDK } from "../sdk.js";

/** Create a mock inbox entry for testing. */
function mockEntry(opts: { id?: number; chatId?: string; content?: string } = {}): InboxEntryWithMessage {
  const chatId = opts.chatId ?? "chat-1";
  return {
    id: opts.id ?? 1,
    inboxId: "inbox-test",
    messageId: `msg-${opts.id ?? 1}`,
    chatId,
    status: "delivered",
    retryCount: 0,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    ackedAt: null,
    message: {
      id: `msg-${opts.id ?? 1}`,
      chatId,
      senderId: "sender-1",
      format: "text",
      content: opts.content ?? "hello",
      metadata: {},
      replyToInbox: null,
      replyToChat: null,
      inReplyTo: null,
      createdAt: new Date().toISOString(),
    },
  };
}

/** Create a mock SDK that satisfies AgentHubSDK shape. */
function mockSdk(): AgentHubSDK {
  return {
    register: vi.fn(),
    pull: vi.fn(),
    ack: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
  } as unknown as AgentHubSDK;
}

describe("SessionManager", () => {
  it("creates a session per chat", async () => {
    const handleCalls: string[] = [];
    const factory: HandlerFactory = () => ({
      async handle(entry) {
        handleCalls.push(entry.chatId ?? entry.message.chatId);
      },
    });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      handlerFactory: factory,
      handlerConfig: {},
      agentIdentity: { agentId: "agent-1", displayName: "Agent" },
      sdk,
      log: () => {},
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-a" }));

    expect(handleCalls).toEqual(["chat-a", "chat-b", "chat-a"]);
    expect(sm.activeCount).toBe(2);

    await sm.shutdown();
  });

  it("delivers messages serially within the same chat", async () => {
    const order: number[] = [];
    let resolveFirst: (() => void) | undefined;
    let callCount = 0;

    const factory: HandlerFactory = () => ({
      async handle(entry) {
        callCount++;
        if (callCount === 1) {
          // First message blocks until we release it
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        order.push(entry.id);
      },
    });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      handlerFactory: factory,
      handlerConfig: {},
      agentIdentity: { agentId: "agent-1", displayName: null },
      sdk,
      log: () => {},
    });

    // Dispatch two messages to the same chat
    const p1 = sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    // Second dispatch while first is processing — should be queued
    sm.dispatch(mockEntry({ id: 2, chatId: "chat-1" }));

    // Only first should have started
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);
    expect(callCount).toBe(1);

    // Release first
    if (resolveFirst) resolveFirst();
    await p1;
    // drainQueue is async, give it time
    await new Promise((r) => setTimeout(r, 50));

    expect(order).toEqual([1, 2]);

    await sm.shutdown();
  });

  it("evicts LRU session when max_sessions is reached", async () => {
    const factory: HandlerFactory = () => ({
      async handle() {},
      async shutdown() {},
    });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 2 },
      handlerFactory: factory,
      handlerConfig: {},
      agentIdentity: { agentId: "agent-1", displayName: null },
      sdk,
      log: () => {},
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-2" }));
    expect(sm.activeCount).toBe(2);

    // Third chat should evict the oldest (chat-1)
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-3" }));
    expect(sm.activeCount).toBe(2);

    await sm.shutdown();
  });

  it("calls handler.shutdown on session manager shutdown", async () => {
    const shutdownCalled = vi.fn();

    const factory: HandlerFactory = () => ({
      async handle() {},
      async shutdown() {
        shutdownCalled();
      },
    });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      handlerFactory: factory,
      handlerConfig: {},
      agentIdentity: { agentId: "agent-1", displayName: null },
      sdk,
      log: () => {},
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-2" }));

    await sm.shutdown();
    expect(shutdownCalled).toHaveBeenCalledTimes(2);
    expect(sm.activeCount).toBe(0);
  });

  it("passes HandlerContext to handler", async () => {
    const captured: { ctx?: HandlerContext } = {};

    const factory: HandlerFactory = () => ({
      async handle(_entry, ctx) {
        captured.ctx = ctx;
      },
    });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      handlerFactory: factory,
      handlerConfig: {},
      agentIdentity: { agentId: "my-agent", displayName: "My Agent" },
      sdk,
      log: () => {},
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));

    expect(captured.ctx).toBeDefined();
    expect(captured.ctx?.agent.agentId).toBe("my-agent");
    expect(captured.ctx?.agent.displayName).toBe("My Agent");
    expect(captured.ctx?.sdk).toBe(sdk);
    expect(typeof captured.ctx?.log).toBe("function");

    await sm.shutdown();
  });

  it("catches handler errors without crashing", async () => {
    const logs: string[] = [];

    const factory: HandlerFactory = () => ({
      async handle() {
        throw new Error("handler boom");
      },
    });

    const sdk = mockSdk();
    const sm = new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10 },
      handlerFactory: factory,
      handlerConfig: {},
      agentIdentity: { agentId: "agent-1", displayName: null },
      sdk,
      log: (msg) => logs.push(msg),
    });

    // Should not throw
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));

    expect(logs.some((l) => l.includes("handler error"))).toBe(true);

    await sm.shutdown();
  });
});
