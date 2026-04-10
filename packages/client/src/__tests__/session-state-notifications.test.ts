import type { InboxEntryWithMessage, SessionState } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";

/**
 * Tests for per-session state notifications (onStateChange callback),
 * deduplication via lastReportedStates, getSessionStates(), and shutdown reporting.
 */

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
  handlerFactory?: HandlerFactory;
  session?: { idle_timeout: number; max_sessions: number };
  concurrency?: number;
  log?: (msg: string) => void;
  onStateChange?: (chatId: string, state: SessionState) => void;
}) {
  const handler = opts.handler ?? createMockHandler();
  const factory: HandlerFactory = opts.handlerFactory ?? (() => handler);
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
    onStateChange: opts.onStateChange,
  });
}

describe("SessionManager: state notifications", () => {
  it("fires onStateChange('active') when a new session starts", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionManager({
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ chatId: "chat-a", state: "active" });

    await sm.shutdown();
  });

  it("fires onStateChange('suspended') when a session is preempted", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionManager({
      concurrency: 1,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // chat-a: active, then suspended (preempted); chat-b: active
    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    const chatBChanges = stateChanges.filter((c) => c.chatId === "chat-b");

    expect(chatAChanges).toEqual([
      { chatId: "chat-a", state: "active" },
      { chatId: "chat-a", state: "suspended" },
    ]);
    expect(chatBChanges).toEqual([{ chatId: "chat-b", state: "active" }]);

    await sm.shutdown();
  });

  it("fires onStateChange('evicted') when a session is evicted", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const handlers: AgentHandler[] = [];
    const sm = createSessionManager({
      session: { idle_timeout: 300, max_sessions: 2 },
      handlerFactory: () => {
        const h = createMockHandler();
        handlers.push(h);
        return h;
      },
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // Third chat triggers eviction of chat-a (LRU)
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" }));

    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    expect(chatAChanges).toContainEqual({ chatId: "chat-a", state: "evicted" });

    await sm.shutdown();
  });

  it("fires onStateChange('active') on resume after suspension", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionManager({
      concurrency: 1,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    // chat-a starts (active), chat-b preempts chat-a (suspended → active)
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // chat-a resumes, preempting chat-b
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-a" }));

    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    expect(chatAChanges).toEqual([
      { chatId: "chat-a", state: "active" },
      { chatId: "chat-a", state: "suspended" },
      { chatId: "chat-a", state: "active" },
    ]);

    await sm.shutdown();
  });

  it("does not fire onStateChange when no callback is provided", async () => {
    // Should not throw
    const sm = createSessionManager({});
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.shutdown();
  });
});

describe("SessionManager: state deduplication", () => {
  it("does not fire duplicate 'active' notifications for the same session", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];

    // Concurrency 1: chat-a starts, chat-b preempts, chat-a resumes, chat-b preempts again
    const sm = createSessionManager({
      concurrency: 1,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" })); // active
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" })); // a→suspended, b→active
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-a" })); // b→suspended, a→active
    await sm.dispatch(mockEntry({ id: 4, chatId: "chat-b" })); // a→suspended, b→active

    // Each chat should alternate active/suspended with no duplicates
    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    const chatBChanges = stateChanges.filter((c) => c.chatId === "chat-b");

    // No two consecutive identical states
    for (const changes of [chatAChanges, chatBChanges]) {
      for (let i = 1; i < changes.length; i++) {
        expect(changes[i]?.state).not.toBe(changes[i - 1]?.state);
      }
    }

    await sm.shutdown();
  });
});

describe("SessionManager: getSessionStates()", () => {
  it("returns all current session states", async () => {
    const sm = createSessionManager({
      concurrency: 1,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    const states = sm.getSessionStates();
    expect(states).toHaveLength(2);

    const chatA = states.find((s) => s.chatId === "chat-a");
    const chatB = states.find((s) => s.chatId === "chat-b");

    // chat-b preempted chat-a, so chat-a is suspended, chat-b is active
    expect(chatA?.state).toBe("suspended");
    expect(chatB?.state).toBe("active");

    await sm.shutdown();
  });

  it("returns empty array when no sessions exist", async () => {
    const sm = createSessionManager({});
    expect(sm.getSessionStates()).toEqual([]);
    await sm.shutdown();
  });
});

describe("SessionManager: shutdown state reporting", () => {
  it("reports active sessions as 'suspended' on shutdown", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionManager({
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // Clear state changes from start phase
    stateChanges.length = 0;

    await sm.shutdown();

    // Both active sessions should be reported as suspended
    expect(stateChanges).toContainEqual({ chatId: "chat-a", state: "suspended" });
    expect(stateChanges).toContainEqual({ chatId: "chat-b", state: "suspended" });
  });

  it("does not report already-suspended sessions on shutdown", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionManager({
      concurrency: 1,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // chat-a is already suspended (preempted by chat-b)
    stateChanges.length = 0;

    await sm.shutdown();

    // Only chat-b (active) should get a suspended notification
    // chat-a was already suspended (and dedup prevents re-notification)
    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    expect(chatAChanges).toHaveLength(0);

    const chatBChanges = stateChanges.filter((c) => c.chatId === "chat-b");
    expect(chatBChanges).toEqual([{ chatId: "chat-b", state: "suspended" }]);
  });
});
