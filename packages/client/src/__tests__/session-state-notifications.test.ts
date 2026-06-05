import type { RuntimeState, SessionState } from "@first-tree/shared";
import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/**
 * Tests for per-session state notifications (onStateChange callback),
 * deduplication via lastReportedStates, getSessionStates(), and shutdown reporting.
 */

function mockSdk(): FirstTreeHubSDK {
  return {
    register: vi.fn(),
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
  session?: {
    idle_timeout: number;
    max_sessions: number;
    working_grace_seconds: number;
    reconcile_interval_seconds: number;
  };
  concurrency?: number;
  log?: pino.Logger;
  onStateChange?: (chatId: string, state: SessionState) => void;
  onSessionRuntimeChange?: (chatId: string, state: RuntimeState) => void;
}) {
  const handler = opts.handler ?? createMockHandler();
  const factory: HandlerFactory = opts.handlerFactory ?? (() => handler);
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
    ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    onStateChange: opts.onStateChange,
    onSessionRuntimeChange: opts.onSessionRuntimeChange,
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

  it("does NOT emit a state notification when a session is LRU-evicted", async () => {
    // LRU eviction is local-only: emitting any wire state on eviction would
    // either accumulate stale rows in agent_chat_sessions (for `suspended`)
    // or conflict with the server-authoritative `evicted` terminal. The row
    // stays as last reported; local `evictedMappings` handles resume.
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const handlers: AgentHandler[] = [];
    const sm = createSessionManager({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
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
    // Only the initial `active` for chat-a should appear — no wire event on LRU.
    expect(chatAChanges).toEqual([{ chatId: "chat-a", state: "active" }]);

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
    // After bind reset, chat-a may resume and preempt chat-b.
    sm.noteBindRecoveryComplete();
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

describe("SessionManager: state-before-runtime ordering (codex review P2)", () => {
  // The server's `setSessionRuntime` is active-gated — if `session:state
  // active` hasn't landed yet, any `session:runtime` for the same
  // (agent, chat) is dropped. Handlers (codex especially) emit
  // `setRuntimeState("working")` synchronously from inside handler.start(),
  // and codex's start() awaits the WHOLE turn before returning. If
  // SessionManager fired the `active` notification only AFTER start()
  // returned, the working frame would arrive at the server before the
  // active row existed and the composite would stay `ready`. This test
  // pins the fixed order: the `active` notification fires before the
  // handler returns (so before any setRuntimeState the handler does).
  it("emits onStateChange('active') BEFORE handler.start (so handler runtime reports land on an active row)", async () => {
    const emissions: Array<{ kind: "state" | "runtime"; value: string }> = [];
    let observedActiveBeforeHandlerCompletion = false;

    const handler = createMockHandler({
      // Codex-style handler: awaits the entire turn. Synchronously reports
      // working at the top, then idle on the way out, all before start()
      // returns. The pre-fix SessionManager would have queued both frames
      // ahead of the `active` notification.
      start: vi.fn(async (_msg, ctx: SessionContext) => {
        // Snapshot the state emissions seen so far — if the `active`
        // notification fired before invoking start, it must already be in
        // `emissions`.
        observedActiveBeforeHandlerCompletion = emissions.some((e) => e.kind === "state" && e.value === "active");
        ctx.setRuntimeState("working");
        ctx.setRuntimeState("idle");
        return "session-id-mock";
      }),
    });

    const sm = createSessionManager({
      handler,
      onStateChange: (_chatId, state) => emissions.push({ kind: "state", value: state }),
      onSessionRuntimeChange: (_chatId, state) => emissions.push({ kind: "runtime", value: state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-codex" }));

    // The snapshot captured at the top of handler.start() must have already
    // included the `active` state — proving notifySessionState fired BEFORE
    // we entered the handler.
    expect(observedActiveBeforeHandlerCompletion).toBe(true);

    // Belt-and-braces: the first emission overall must be the active state
    // notification (no runtime frame slipped in before it).
    expect(emissions[0]).toEqual({ kind: "state", value: "active" });

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

describe("SessionManager: getEvictedChatIds()", () => {
  // After a process restart, SessionRegistry hydrates every persisted
  // (chatId → claudeSessionId) row into `evictedMappings` — `sessions` is
  // empty. The agent-slot full-state-sync uses these chatIds to advertise
  // them as "suspended" on the wire so the server's
  // `agent_chat_sessions.state` isn't stuck on a pre-restart snapshot.
  it("returns evictedMappings keys (LRU-evicted chats included)", async () => {
    const sm = createSessionManager({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // chat-c forces LRU eviction of the older chat (chat-a is suspended-then-evicted
    // out of `sessions` into `evictedMappings`).
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" }));

    const evicted = new Set(sm.getEvictedChatIds());
    expect(evicted.has("chat-a")).toBe(true);

    await sm.shutdown();
  });

  it("returns empty array when nothing has been evicted", async () => {
    const sm = createSessionManager({});
    expect(sm.getEvictedChatIds()).toEqual([]);
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

describe("SessionManager: terminate + reconcile", () => {
  it("handleCommand('session:terminate') deletes local state and does NOT emit any state notification", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionManager({
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    stateChanges.length = 0;

    await sm.handleCommand("chat-a", "session:terminate");

    expect(stateChanges).toHaveLength(0); // server is authoritative
    expect(sm.getSessionStates()).toEqual([]);
    expect(sm.getHeldChatIds()).toEqual([]);

    await sm.shutdown();
  });

  it("getHeldChatIds() unions active sessions and evicted mappings", async () => {
    const sm = createSessionManager({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // LRU evicts chat-a into evictedMappings when chat-c enters
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" }));

    const held = new Set(sm.getHeldChatIds());
    expect(held.has("chat-a")).toBe(true); // evictedMappings
    expect(held.has("chat-b") || held.has("chat-c")).toBe(true); // live sessions

    await sm.shutdown();
  });

  it("applyStaleChatIds() cleans up both live sessions and evicted mappings", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionManager({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" })); // chat-a → evictedMappings

    const held = sm.getHeldChatIds();
    expect(held).toContain("chat-a");

    stateChanges.length = 0;
    sm.applyStaleChatIds(held);

    // Wait a tick for the async handleCommand chain to drain
    await new Promise((r) => setTimeout(r, 10));

    expect(sm.getHeldChatIds()).toEqual([]);
    // Terminate should not emit wire notifications; server is authoritative
    expect(stateChanges).toHaveLength(0);

    await sm.shutdown();
  });
});
