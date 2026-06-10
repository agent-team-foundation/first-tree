import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

function defined<T>(value: T | undefined, label = "value"): T {
  expect(value, `${label} should be defined`).toBeDefined();
  return value as T;
}

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

describe("SessionManager runtime state reducer", () => {
  it("reports working from in-flight delivery and idle after finishTurn", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      async start(msg, ctx) {
        capturedMessage = msg;
        capturedCtx = ctx;
        return "session-1";
      },
    });
    const sm = createSessionManager({ handler, onRuntimeStateChange: (state) => runtimeChanges.push(state) });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    expect(runtimeChanges).toContain("working");
    expect(sm.getAggregateRuntimeState()).toBe("working");

    await defined(capturedCtx, "ctx").finishTurn(defined(capturedMessage, "message"), { status: "success" });
    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("idle");
    expect(sm.getAggregateRuntimeState()).toBe("idle");

    await sm.shutdown();
  });

  it("keeps a consumed-but-unfinished turn working", async () => {
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      async start(msg, ctx) {
        capturedMessage = msg;
        capturedCtx = ctx;
        return "session-1";
      },
    });
    const sm = createSessionManager({ handler, onRuntimeStateChange: () => {} });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    defined(capturedCtx, "ctx").markMessagesConsumed(defined(capturedMessage, "message"));

    expect(sm.getSessionRuntimeStates()).toEqual([{ chatId: "chat-a", runtimeState: "working" }]);

    await sm.shutdown();
  });

  it("uses manager-owned terminal marker for runtime error projection", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      async start(msg, ctx) {
        capturedMessage = msg;
        capturedCtx = ctx;
        return "session-1";
      },
    });
    const sm = createSessionManager({ handler, onRuntimeStateChange: (state) => runtimeChanges.push(state) });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await defined(capturedCtx, "ctx").finishTurn(defined(capturedMessage, "message"), {
      status: "error",
      terminal: true,
    });

    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("error");
    expect(sm.getSessionRuntimeStates()).toEqual([{ chatId: "chat-a", runtimeState: "error" }]);

    await sm.shutdown();
  });

  it("clears runtime projection on terminate", async () => {
    const runtimeChanges: Array<"idle" | "working" | "blocked" | "error"> = [];
    const handler = createMockHandler();
    const sm = createSessionManager({ handler, onRuntimeStateChange: (state) => runtimeChanges.push(state) });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    runtimeChanges.length = 0;

    await sm.handleCommand("chat-a", "session:terminate");

    expect(runtimeChanges[runtimeChanges.length - 1]).toBe("idle");
    expect(sm.getSessionRuntimeStates()).toEqual([]);

    await sm.shutdown();
  });

  it("re-affirm timer re-emits working and skips idle", async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<{ chatId: string; state: string }> = [];
      let ctx: SessionContext | undefined;
      let message: SessionMessage | undefined;
      const handler = createMockHandler({
        async start(msg, sessionCtx) {
          message = msg;
          ctx = sessionCtx;
          return "session-1";
        },
      });
      const sm = createSessionManager({
        handler,
        onSessionRuntimeChange: (chatId, state) => seen.push({ chatId, state }),
        session: { idle_timeout: 3600, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-w" }));
      seen.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen.some((event) => event.chatId === "chat-w" && event.state === "working")).toBe(true);

      await defined(ctx, "ctx").finishTurn(defined(message, "message"), { status: "success" });
      seen.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen).toEqual([]);

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionManager.evictIdle with manager-owned runtime state", () => {
  it("does NOT suspend a session with delivery work inside the grace window", async () => {
    vi.useFakeTimers();
    try {
      const handler = createMockHandler();
      const sm = createSessionManager({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-thinking" }));
      await vi.advanceTimersByTimeAsync(20_000);

      expect(handler.suspend).not.toHaveBeenCalled();
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does suspend once delivery work exceeds idle_timeout + working_grace_seconds", async () => {
    vi.useFakeTimers();
    try {
      const handler = createMockHandler();
      const sm = createSessionManager({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 5, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-stuck" }));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(handler.suspend).toHaveBeenCalledTimes(1);
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle sessions suspend at idle_timeout after finishTurn", async () => {
    vi.useFakeTimers();
    try {
      let capturedCtx: SessionContext | undefined;
      let capturedMessage: SessionMessage | undefined;
      const handler = createMockHandler({
        async start(msg, ctx) {
          capturedMessage = msg;
          capturedCtx = ctx;
          return "s-idle";
        },
      });
      const sm = createSessionManager({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-idle" }));
      await defined(capturedCtx, "ctx").finishTurn(defined(capturedMessage, "message"), { status: "success" });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(handler.suspend).toHaveBeenCalledTimes(1);
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle to inject restores working so the grace window protects the next turn", async () => {
    vi.useFakeTimers();
    try {
      let capturedCtx: SessionContext | undefined;
      let capturedMessage: SessionMessage | undefined;
      const handler = createMockHandler({
        async start(msg, ctx) {
          capturedMessage = msg;
          capturedCtx = ctx;
          return "s-inject-grace";
        },
      });
      const sm = createSessionManager({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-inject" }));
      await defined(capturedCtx, "ctx").finishTurn(defined(capturedMessage, "message"), { status: "success" });

      await sm.dispatch(mockEntry({ id: 2, chatId: "chat-inject" }));
      expect(handler.inject).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(handler.suspend).not.toHaveBeenCalled();

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
