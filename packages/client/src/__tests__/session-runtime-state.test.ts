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
  session?: { idle_timeout: number; max_sessions: number; reconcile_interval_seconds: number };
  concurrency?: number;
  log?: pino.Logger;
  onRuntimeStateChange?: (state: "idle" | "working" | "blocked" | "error") => void;
}) {
  const handler = opts.handler ?? createMockHandler();
  const factory: HandlerFactory = opts.handlerFactory ?? (() => handler);
  const sdk = opts.sdk ?? mockSdk();

  return new SessionManager({
    session: opts.session ?? { idle_timeout: 300, max_sessions: 10, reconcile_interval_seconds: 300 },
    concurrency: opts.concurrency ?? 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test" },
    agentIdentity: {
      agentId: "agent-1",
      displayName: "Agent",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    sdk,
    log: opts.log ?? silentLogger(),
    onRuntimeStateChange: opts.onRuntimeStateChange,
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
      session: { idle_timeout: 300, max_sessions: 2, reconcile_interval_seconds: 300 },
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

describe("SessionManager: ackEntry handles entryId correctly", () => {
  it("ACKs entryId from pending queue after concurrency preemption", async () => {
    const sdk = mockSdk();
    const sm = createSessionManager({ sdk, concurrency: 1 });

    // Fill concurrency
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    // This gets queued (concurrency full), then drained when chat-a is preempted
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // Both should be ACKed
    expect(sdk.ack).toHaveBeenCalledWith(1);
    expect(sdk.ack).toHaveBeenCalledWith(2);

    await sm.shutdown();
  });
});
