import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/** Assert value is defined and return it (avoids non-null assertions). */
function defined<T>(value: T | undefined, label = "value"): T {
  expect(value, `${label} should be defined`).toBeDefined();
  return value as T;
}

/**
 * Tests for per-session runtime state aggregation and cleanup.
 *
 * Covers:
 * - Aggregate runtime state recomputation (idle → working → blocked → error priority)
 * - Runtime state cleanup on terminate command
 * - Runtime state cleanup on eviction
 * - Runtime state cleanup on start/resume failure
 */

function mockSdk(): FirstTreeHubSDK {
  return {
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
  } as unknown as FirstTreeHubSDK;
}

function mockAckEntry() {
  return vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
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
  ackEntry?: (entryId: number) => Promise<void>;
  session?: {
    idle_timeout: number;
    max_sessions: number;
    working_grace_seconds: number;
    reconcile_interval_seconds: number;
  };
  concurrency?: number;
  log?: pino.Logger;
  onRuntimeStateChange?: (state: "idle" | "working" | "blocked" | "error") => void;
  onSessionRuntimeChange?: (chatId: string, state: "idle" | "working" | "blocked" | "error") => void;
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
    ackEntry: opts.ackEntry ?? mockAckEntry(),
    onRuntimeStateChange: opts.onRuntimeStateChange,
    onSessionRuntimeChange: opts.onSessionRuntimeChange,
  });
}

describe("SessionManager: runtime state aggregation", () => {
  it("fires onRuntimeStateChange when a session sets working state", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    let capturedCtx: SessionContext | undefined;

    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return "session-1";
      },
    });

    const sm = createSessionManager({
      handler,
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    expect(capturedCtx).toBeDefined();

    // Handler sets working state
    const ctx = defined(capturedCtx, "capturedCtx");
    ctx.setRuntimeState("working");
    expect(runtimeChanges).toContain("working");

    // Handler sets back to idle
    ctx.setRuntimeState("idle");
    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("idle");

    await sm.shutdown();
  });

  it("aggregates to highest priority: error > blocked > working > idle", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    const contexts: SessionContext[] = [];

    const factory: HandlerFactory = () =>
      createMockHandler({
        async start(_msg, ctx) {
          contexts.push(ctx);
          return `session-${contexts.length}`;
        },
      });

    const sm = createSessionManager({
      handlerFactory: factory,
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    expect(contexts).toHaveLength(2);

    // Both idle → aggregate stays idle (initial state, no explicit report yet)
    runtimeChanges.length = 0;

    const ctx0 = defined(contexts[0], "contexts[0]");
    const ctx1 = defined(contexts[1], "contexts[1]");

    // One working → aggregate = working
    ctx0.setRuntimeState("working");
    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("working");

    // Second also working → still working
    ctx1.setRuntimeState("working");
    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("working");

    // One error → aggregate = error (highest priority)
    ctx0.setRuntimeState("error");
    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("error");

    // Clear error, set blocked → aggregate = blocked
    ctx0.setRuntimeState("blocked");
    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("blocked");

    await sm.shutdown();
  });

  it("deduplicates aggregate state — no callback if state unchanged", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    let capturedCtx: SessionContext | undefined;

    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return "s1";
      },
    });

    const sm = createSessionManager({
      handler,
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    runtimeChanges.length = 0;

    const dedupCtx = defined(capturedCtx, "capturedCtx");
    dedupCtx.setRuntimeState("working");
    dedupCtx.setRuntimeState("working"); // duplicate — should not fire
    dedupCtx.setRuntimeState("working"); // duplicate — should not fire
    expect(runtimeChanges).toHaveLength(1);

    await sm.shutdown();
  });
});

describe("SessionManager: runtime state cleanup on terminate", () => {
  it("clears session runtime state and recomputes aggregate on terminate", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    const contexts: SessionContext[] = [];

    const factory: HandlerFactory = () =>
      createMockHandler({
        async start(_msg, ctx) {
          contexts.push(ctx);
          return `s-${contexts.length}`;
        },
      });

    const sm = createSessionManager({
      handlerFactory: factory,
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // chat-a = working, chat-b = idle → aggregate = working
    defined(contexts[0], "contexts[0]").setRuntimeState("working");
    runtimeChanges.length = 0;

    // Terminate chat-a → its "working" state should be cleaned up → aggregate = idle
    await sm.handleCommand("chat-a", "session:terminate");

    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("idle");

    await sm.shutdown();
  });
});

describe("SessionManager: runtime state cleanup on eviction", () => {
  it("clears session runtime state when evicted by max_sessions", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    const contexts: SessionContext[] = [];

    const factory: HandlerFactory = () =>
      createMockHandler({
        async start(_msg, ctx) {
          contexts.push(ctx);
          return `s-${contexts.length}`;
        },
      });

    const sm = createSessionManager({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      handlerFactory: factory,
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // chat-a = error → aggregate = error
    defined(contexts[0], "contexts[0]").setRuntimeState("error");
    runtimeChanges.length = 0;

    // Third chat triggers eviction of LRU (chat-a with error) → aggregate should drop from error
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" }));

    // After chat-a evicted, its "error" state is gone, aggregate should not be "error"
    const lastState = runtimeChanges[runtimeChanges.length - 1];
    expect(lastState).not.toBe("error");

    await sm.shutdown();
  });
});

describe("SessionManager: runtime state cleanup on start failure", () => {
  it("clears session runtime state when handler.start throws", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    let callCount = 0;

    const factory: HandlerFactory = () => {
      callCount++;
      if (callCount === 2) {
        // Second handler throws on start
        return createMockHandler({
          async start() {
            throw new Error("start boom");
          },
        });
      }
      return createMockHandler();
    };

    const sm = createSessionManager({
      handlerFactory: factory,
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
      log: silentLogger(),
    });

    // First session starts fine
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    // Second session fails to start — should not leave orphaned runtime state
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // Only chat-a should be tracked
    expect(sm.totalCount).toBe(1);

    // Aggregate should not be affected by the failed session
    // If there was a leak, the failed session's state would pollute the aggregate
    const lastState = runtimeChanges.length > 0 ? runtimeChanges[runtimeChanges.length - 1] : null;
    // Should be null (no runtime state set) or "idle" — never "error" or "working"
    expect(lastState === null || lastState === "idle").toBe(true);

    await sm.shutdown();
  });
});

describe("SessionManager: getAggregateRuntimeState()", () => {
  it("returns null when no sessions have reported state", async () => {
    const sm = createSessionManager({});
    expect(sm.getAggregateRuntimeState()).toBeNull();
    await sm.shutdown();
  });

  it("returns current aggregate after session reports", async () => {
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return "s1";
      },
    });

    const sm = createSessionManager({
      handler,
      onRuntimeStateChange: () => {},
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    defined(capturedCtx, "ctx").setRuntimeState("working");
    expect(sm.getAggregateRuntimeState()).toBe("working");

    defined(capturedCtx, "ctx").setRuntimeState("idle");
    expect(sm.getAggregateRuntimeState()).toBe("idle");

    await sm.shutdown();
  });
});

describe("SessionManager: per-(agent,chat) runtime callback (#553 rebase)", () => {
  it("fires onSessionRuntimeChange with the chatId whenever a session reports runtime", async () => {
    const events: Array<{ chatId: string; state: string }> = [];
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return "s1";
      },
    });

    const sm = createSessionManager({
      handler,
      onSessionRuntimeChange: (chatId, state) => events.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    defined(capturedCtx, "ctx").setRuntimeState("working");
    defined(capturedCtx, "ctx").setRuntimeState("idle");

    // dispatch flow itself sets working before handler.start (the inject→working
    // grace-window fix). We only care that the explicit setRuntimeState calls
    // emitted with the right chatId.
    const forChatA = events.filter((e) => e.chatId === "chat-a").map((e) => e.state);
    expect(forChatA).toContain("working");
    expect(forChatA).toContain("idle");

    await sm.shutdown();
  });

  it("getSessionRuntimeStates returns ACTIVE sessions only, defaulting to idle when unrecorded", async () => {
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return "s-a";
      },
    });

    const sm = createSessionManager({ handler, onSessionRuntimeChange: () => {} });
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    defined(capturedCtx, "ctx").setRuntimeState("working");

    const snap = sm.getSessionRuntimeStates();
    expect(snap).toEqual([{ chatId: "chat-a", runtimeState: "working" }]);

    await sm.shutdown();
  });

  it("re-affirm timer re-emits working / blocked / error, skips idle", async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<{ chatId: string; state: string }> = [];
      const contexts: SessionContext[] = [];
      const factory: HandlerFactory = () =>
        createMockHandler({
          async start(_msg, ctx) {
            contexts.push(ctx);
            return `s-${contexts.length}`;
          },
        });

      const sm = createSessionManager({
        handlerFactory: factory,
        onSessionRuntimeChange: (chatId, state) => seen.push({ chatId, state }),
        session: { idle_timeout: 3600, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-w" }));
      await sm.dispatch(mockEntry({ id: 2, chatId: "chat-i" }));
      defined(contexts[0], "ctx0").setRuntimeState("working");
      defined(contexts[1], "ctx1").setRuntimeState("idle");

      // Drain the initial callback noise so the assertion below targets
      // only re-affirm output.
      seen.length = 0;

      // Reaffirm base = 20s + ±20% jitter — 60s straddles the upper bound
      // (24s) twice so at least one fire is guaranteed even at max jitter.
      await vi.advanceTimersByTimeAsync(60_000);

      const reaffirms = seen.filter((e) => e.chatId === "chat-w" || e.chatId === "chat-i");
      const workingReaffirms = reaffirms.filter((e) => e.chatId === "chat-w" && e.state === "working");
      const idleReaffirms = reaffirms.filter((e) => e.chatId === "chat-i");
      expect(workingReaffirms.length).toBeGreaterThanOrEqual(1);
      // idle sessions must NEVER show up on the reaffirm channel — that's
      // pure wire noise (server's fail-closed default already handles it).
      expect(idleReaffirms).toHaveLength(0);

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionManager: ackEntry handles entryId correctly", () => {
  it("ACKs entryId from pending queue after concurrency preemption", async () => {
    const ackEntry = mockAckEntry();
    const sm = createSessionManager({ ackEntry, concurrency: 1 });

    // Fill concurrency
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    // This gets queued (concurrency full), then drained when chat-a is preempted
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // Both should be ACKed
    expect(ackEntry).toHaveBeenCalledWith(1);
    expect(ackEntry).toHaveBeenCalledWith(2);

    await sm.shutdown();
  });
});

describe("SessionManager.evictIdle — working-state grace window", () => {
  // A long thinking turn or one giant SDK message produces no inbound events
  // for minutes at a time, so `lastActivity` (refreshed only by handler
  // `touch()`) drifts past `idle_timeout` even though the handler is still
  // working. Without this grace window the runtime suspends the SDK
  // mid-thought; with it, the slot survives until either work resumes or the
  // upper bound `idle_timeout + working_grace_seconds` is exceeded.
  it("does NOT suspend a session whose runtimeState is 'working' inside the grace window", async () => {
    vi.useFakeTimers();
    try {
      let capturedCtx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, ctx) {
          capturedCtx = ctx;
          return "s-working";
        },
      });
      const sm = createSessionManager({
        handler,
        // 1s idle window + 60s grace — picked so a single 20s tick lands
        // inside the grace window.
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-thinking" }));
      defined(capturedCtx, "ctx").setRuntimeState("working");

      // 20s ≫ idle_timeout (1s) but ≪ idle_timeout + grace (61s).
      await vi.advanceTimersByTimeAsync(20_000);

      expect(handler.suspend).not.toHaveBeenCalled();
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("DOES suspend once inactiveMs exceeds idle_timeout + working_grace_seconds", async () => {
    vi.useFakeTimers();
    try {
      let capturedCtx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, ctx) {
          capturedCtx = ctx;
          return "s-stuck";
        },
      });
      const sm = createSessionManager({
        handler,
        // 1s idle + 5s grace — the timer below blows past the 6s cap so
        // the runtime should give up and reclaim the slot.
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 5, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-stuck" }));
      defined(capturedCtx, "ctx").setRuntimeState("working");

      // 30s ≫ idle_timeout + grace (6s). evictIdle ticks every 10s.
      await vi.advanceTimersByTimeAsync(30_000);

      expect(handler.suspend).toHaveBeenCalledTimes(1);
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  // `blocked` is no longer auto-set by evictIdle (the 120s auto-migration
  // was removed because reasoning-model thinking turns commonly exceed 2
  // minutes between SDK events, producing false-positive UI warnings).
  // The grace-window exemption still covers `blocked` so any handler that
  // sets it explicitly — present or future — is treated like `working`.
  it("also exempts 'blocked' from idle suspend inside the grace window", async () => {
    vi.useFakeTimers();
    try {
      let capturedCtx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, ctx) {
          capturedCtx = ctx;
          return "s-blocked";
        },
      });
      const sm = createSessionManager({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-blocked" }));
      defined(capturedCtx, "ctx").setRuntimeState("blocked");

      await vi.advanceTimersByTimeAsync(20_000);

      expect(handler.suspend).not.toHaveBeenCalled();
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("'idle' runtimeState still suspends at idle_timeout (regression)", async () => {
    vi.useFakeTimers();
    try {
      let capturedCtx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, ctx) {
          capturedCtx = ctx;
          return "s-idle";
        },
      });
      const sm = createSessionManager({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-idle" }));
      defined(capturedCtx, "ctx").setRuntimeState("idle");

      await vi.advanceTimersByTimeAsync(20_000);

      expect(handler.suspend).toHaveBeenCalledTimes(1);
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression for the removed 120s working→blocked auto-migration.
  // Before this change evictIdle would flip a `working` session to
  // `blocked` after 2 minutes of SDK silence, surfacing as a yellow UI
  // warning even when the agent was just deep-thinking. The grace
  // window above proved that's never a real problem (we don't actually
  // suspend), so the auto-migration was pure UX noise — removed.
  it("does NOT auto-migrate 'working' → 'blocked' on inactivity (no false alarms during long reasoning)", async () => {
    vi.useFakeTimers();
    try {
      const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
      let capturedCtx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, ctx) {
          capturedCtx = ctx;
          return "s-no-auto-blocked";
        },
      });
      const sm = createSessionManager({
        handler,
        // Big idle_timeout so we don't trip the suspend path while we're
        // proving the *non*-transition.
        session: { idle_timeout: 3600, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
        onRuntimeStateChange: (state) => runtimeChanges.push(state),
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-thinking" }));
      defined(capturedCtx, "ctx").setRuntimeState("working");
      runtimeChanges.length = 0;

      // Past the old 120s threshold; the runtime would previously have
      // flipped the state to `blocked` here.
      await vi.advanceTimersByTimeAsync(180_000);

      expect(runtimeChanges).not.toContain("blocked");
      expect(handler.suspend).not.toHaveBeenCalled();
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  // Reproduces the post-#477 regression observed in production: a turn that
  // ends with `setRuntimeState("idle")` (handler claude-code does this on
  // every result message) left the next inject-triggered turn observable
  // as `idle`, so a long thinking turn that produced no SDK output for
  // `idle_timeout` (300s) tripped evictIdle's suspend path even though the
  // agent was still working. `dispatch` for an active chat must put the
  // session back into `working` BEFORE the handler starts its next turn
  // so the grace-window guard above kicks in.
  it("'idle' → inject restores 'working' so the grace window protects long thinking turns", async () => {
    vi.useFakeTimers();
    try {
      let capturedCtx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, ctx) {
          capturedCtx = ctx;
          return "s-inject-grace";
        },
      });
      const sm = createSessionManager({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-inject" }));
      // Handler completed its first turn — back to idle, mirroring
      // claude-code.ts on every result message.
      defined(capturedCtx, "ctx").setRuntimeState("idle");

      // User sends a follow-up. Without the inject→working fix, this
      // refreshes lastActivity but leaves runtimeState=idle, so the next
      // evictIdle tick past idle_timeout would suspend the chat
      // mid-thinking.
      await sm.dispatch(mockEntry({ id: 2, chatId: "chat-inject" }));
      expect(handler.inject).toHaveBeenCalledTimes(1);

      // 20s ≫ idle_timeout (1s) but ≪ idle_timeout + grace (61s). The
      // handler is "thinking" — no touch() calls — so lastActivity stays
      // pinned at the inject moment. The grace window must keep the slot
      // alive.
      await vi.advanceTimersByTimeAsync(20_000);

      expect(handler.suspend).not.toHaveBeenCalled();
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
