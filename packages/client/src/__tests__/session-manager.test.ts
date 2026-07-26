import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRuntimeConfig,
  encodeProviderRetryEventMessage,
  RUNTIME_NOTICE_METADATA_KEY,
  type SessionEvent,
} from "@first-tree/shared";
import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { ContextTreeBinding } from "../runtime/bootstrap.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
  TurnOutcome,
} from "../runtime/handler.js";
import type { SubprocessProbe } from "../runtime/process-tree-probe.js";
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

function mockRuntimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "tester",
    payload: {
      kind: "claude-code",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "",
    },
  };
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
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function finishEntry(
  ctx: SessionContext | undefined,
  entryId: number,
  chatId: string,
  messageId = `msg-${entryId}`,
): Promise<void> {
  await ctx?.finishTurn(
    {
      inboxEntryId: entryId,
      id: messageId,
      chatId,
      senderId: "sender-1",
      format: "text",
      content: "",
      metadata: {},
    },
    { status: "success", terminal: true },
  );
}

function emitCodexTerminalProviderFailure(ctx: SessionContext, messagePreview: string): void {
  ctx.emitEvent({
    kind: "error",
    payload: {
      source: "runtime",
      message: encodeProviderRetryEventMessage({
        event: "provider_failure_terminal",
        provider: "codex",
        scope: "provider_turn",
        category: "credential",
        reasonCode: "provider_credential_required",
        replaySafety: "provider_entered",
        userSeverity: "error",
        messagePreview,
      }),
    },
  });
}

function emitCodexRetryExhausted(ctx: SessionContext, messagePreview: string): void {
  ctx.emitEvent({
    kind: "error",
    payload: {
      source: "runtime",
      message: encodeProviderRetryEventMessage({
        event: "provider_retry_exhausted",
        provider: "codex",
        scope: "provider_turn",
        category: "provider_capacity",
        reasonCode: "provider_overloaded_exhausted",
        replaySafety: "user_visible",
        userSeverity: "error",
        messagePreview,
      }),
    },
  });
}

function emitClaudeProviderFailure(
  ctx: SessionContext,
  input: {
    event?: "provider_failure_terminal" | "provider_retry_exhausted";
    category: "credential" | "provider_capacity" | "transient_transport";
    reasonCode: string;
    messagePreview: string;
    userSeverity?: "info" | "warning" | "error";
  },
): void {
  ctx.emitEvent({
    kind: "error",
    payload: {
      source: "runtime",
      message: encodeProviderRetryEventMessage({
        event: input.event ?? "provider_failure_terminal",
        provider: "claude-code",
        scope: "provider_turn",
        category: input.category,
        reasonCode: input.reasonCode,
        replaySafety: "provider_entered",
        userSeverity: input.userSeverity ?? "error",
        messagePreview: input.messagePreview,
      }),
    },
  });
}

function createSessionManager(opts: {
  sdk?: FirstTreeHubSDK;
  handler?: AgentHandler;
  handlerConfig?: HandlerConfig;
  handlerFactory?: HandlerFactory;
  resolveContextTreeBinding?: () => Promise<ContextTreeBinding | null>;
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
  recoverChat?: (chatId: string) => Promise<void>;
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  subprocessProbe?: SubprocessProbe;
  registryPath?: string;
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
    subprocessProbe: opts.subprocessProbe,
    handlerFactory: factory,
    handlerConfig: opts.handlerConfig ?? { workspaceRoot: "/tmp/test" },
    // Tests never want the live git-backed resolver — default to a no-op so a
    // tree-less handlerConfig stays tree-less unless a test opts in.
    resolveContextTreeBinding: opts.resolveContextTreeBinding ?? (async () => null),
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
    registryPath: opts.registryPath,
    ackEntry: opts.ackEntry ?? mockAckEntry(),
    recoverChat: opts.recoverChat,
    agentConfigCache: opts.agentConfigCache,
    onSessionEvent: opts.onSessionEvent,
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

  it("does NOT ack on dispatch — entry is held until the handler finishes the turn (in-flight recovery)", async () => {
    // Post-inflight-message-recovery: dispatch only enqueues the entry into
    // the delivery coordinator. The ack waits for the handler to signal turn
    // completion via `ctx.finishTurn(...)`. A bare-mocked handler never closes
    // the turn, so no ack is fired.
    const ackEntry = mockAckEntry();
    const sm = createSessionManager({ ackEntry });

    await sm.dispatch(mockEntry({ id: 42, chatId: "chat-1" }));

    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("acks via the callback when the handler calls ctx.finishTurn(...)", async () => {
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
    await finishEntry(capturedCtx, 42, "chat-1");
    expect(ackEntry).toHaveBeenCalledWith(42);

    await sm.shutdown();
  });

  it("persists a handler-replaced session id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-manager-rebind-"));
    const registryPath = join(dir, "sessions.json");
    let capturedCtx: SessionContext | undefined;
    const handler = createMockHandler({
      async start(_msg, ctx) {
        capturedCtx = ctx;
        return { sessionId: "session-old", route: { kind: "owned", mode: "processing" } as const };
      },
    });
    const sm = createSessionManager({ handler, registryPath });
    try {
      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-rebind" }));
      capturedCtx?.replaceSessionId?.("session-new", "codex_stale_rollout_recovered");
      await sm.shutdown();

      const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
        entries: Record<string, { claudeSessionId: string }>;
      };
      expect(raw.entries["chat-rebind"]?.claudeSessionId).toBe("session-new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("does NOT re-ack a dedup-hit while the entry is still in-flight (handler has not finished the turn yet)", async () => {
    // The first dispatch creates the in-flight slot; the second dispatch
    // (same chatId+messageId, same entryId — what `agent:bind` reset +
    // drainBacklog produces while a turn is still mid-flight) must NOT
    // ack — that would defuse inflight-message-recovery if this process
    // crashed mid-turn. The eventual `finishTurn` is the only thing
    // that should ack while the turn is open.
    const ackEntry = mockAckEntry();
    const handler = createMockHandler();
    const sm = createSessionManager({ ackEntry, handler });

    await sm.dispatch(mockEntry({ id: 50, chatId: "chat-mid", messageId: "msg-mid" }));
    await sm.dispatch(mockEntry({ id: 50, chatId: "chat-mid", messageId: "msg-mid" }));

    // Second dispatch is a dedup-hit, but the entry is still tracked by the
    // coordinator (handler never called finishTurn in this test), so re-ack
    // must be skipped.
    expect(ackEntry).not.toHaveBeenCalled();
    expect(handler.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("does not recover while an earlier same-chat delivery is normally admitting", async () => {
    const refresh = deferred<AgentRuntimeConfig>();
    const agentConfigCache: AgentConfigCache = {
      get: vi.fn(),
      refreshIfNewer: vi.fn(() => refresh.promise),
      refresh: vi.fn(() => Promise.resolve(mockRuntimeConfig())),
      updateSdk: vi.fn(),
      updateUrls: vi.fn(),
      allReferencedUrls: vi.fn(() => new Set<string>()),
      forget: vi.fn(),
    };
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const injectSpy = vi.fn().mockReturnValue({ kind: "owned", mode: "queued" });
    const startSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({
      start: startSpy,
      inject: injectSpy,
    });
    const sm = createSessionManager({ handler, agentConfigCache, recoverChat });

    const firstDispatch = sm.dispatch(mockEntry({ id: 60, chatId: "chat-admit", messageId: "msg-admit-1" }));
    await vi.waitFor(() => expect(agentConfigCache.refreshIfNewer).toHaveBeenCalledTimes(1));

    const secondDispatch = sm.dispatch(mockEntry({ id: 61, chatId: "chat-admit", messageId: "msg-admit-2" }));
    await Promise.resolve();
    expect(recoverChat).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    refresh.resolve(mockRuntimeConfig());
    await firstDispatch;
    await secondDispatch;

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("queues a new chat instead of evicting working sessions at max_sessions", async () => {
    const ackEntry = mockAckEntry();
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const handlers: AgentHandler[] = [];
    const factory: HandlerFactory = () => {
      const h = createMockHandler({
        start: vi.fn(async (message, ctx) => {
          ctx.markMessagesConsumed(message);
          return `session-${message.chatId}`;
        }),
      });
      handlers.push(h);
      return h;
    };
    const sm = createSessionManager({
      ackEntry,
      handlerFactory: factory,
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 70, chatId: "chat-a", messageId: "msg-a" }));
    await sm.dispatch(mockEntry({ id: 71, chatId: "chat-b", messageId: "msg-b" }));
    expect(sm.totalCount).toBe(2);

    await sm.dispatch(mockEntry({ id: 72, chatId: "chat-c", messageId: "msg-c" }));

    expect(sm.totalCount).toBe(2);
    expect(handlers).toHaveLength(2);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("drains max_sessions queue after a working session becomes idle", async () => {
    const ackEntry = mockAckEntry();
    const contexts = new Map<string, SessionContext>();
    const messages = new Map<string, SessionMessage>();
    const started: string[] = [];
    const factory: HandlerFactory = () =>
      createMockHandler({
        async start(message, ctx) {
          contexts.set(message.chatId, ctx);
          messages.set(message.chatId, message);
          started.push(message.chatId);
          ctx.markMessagesConsumed(message);
          return `session-${message.chatId}`;
        },
      });
    const sm = createSessionManager({
      ackEntry,
      handlerFactory: factory,
      concurrency: 1,
      session: { idle_timeout: 300, max_sessions: 1, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    });

    await sm.dispatch(mockEntry({ id: 80, chatId: "chat-a", messageId: "msg-a" }));
    await sm.dispatch(mockEntry({ id: 81, chatId: "chat-b", messageId: "msg-b" }));
    expect(started).toEqual(["chat-a"]);

    const ctx = contexts.get("chat-a");
    const message = messages.get("chat-a");
    if (!ctx || !message) throw new Error("chat-a context missing");
    await ctx.finishTurn(message, { status: "success", terminal: true });

    await vi.waitFor(() => expect(started).toEqual(["chat-a", "chat-b"]));

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
    await finishEntry(capturedCtx, 60, "chat-redeliver", "msg-redeliver");
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

  it("recovers active inject work when the handler rejects custody", async () => {
    const ackEntry = mockAckEntry();
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const handler = createMockHandler({
      inject: vi.fn().mockReturnValue({ kind: "rejected", reason: "no_active_context", retryable: true } as const),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-reject", messageId: "msg-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-reject", messageId: "msg-2" }));

    expect(handler.inject).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-reject"));
    expect(sm.getAggregateRuntimeState()).not.toBe("working");

    await sm.shutdown();
  });

  it("recovers active inject work when the handler throws before custody", async () => {
    const ackEntry = mockAckEntry();
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const handler = createMockHandler({
      inject: vi.fn(() => {
        throw new Error("inject offline");
      }),
    });
    const sm = createSessionManager({ handler, ackEntry, recoverChat });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-throw", messageId: "msg-1" }));
    await expect(sm.dispatch(mockEntry({ id: 2, chatId: "chat-throw", messageId: "msg-2" }))).rejects.toThrow(
      "inject offline",
    );

    expect(ackEntry).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-throw"));
    expect(sm.getAggregateRuntimeState()).not.toBe("working");

    await sm.shutdown();
  });

  it("routes recovery redelivery through resume after a handler fails its dead active consumer", async () => {
    const ackEntry = mockAckEntry();
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let startCtx: SessionContext | undefined;
    let startMessage: SessionMessage | undefined;
    let startToken: DeliveryToken | undefined;
    let injectedMessage: SessionMessage | undefined;
    let injectedToken: DeliveryToken | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        startCtx = ctx;
        startMessage = message;
        startToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "processing" } as const };
      }),
      inject: vi.fn((message, token) => {
        injectedMessage = message;
        injectedToken = token;
        return { kind: "owned", mode: "queued" } as const;
      }),
      resume: vi.fn(async () => {
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "processing" } as const };
      }),
    });
    const sm = createSessionManager({ handler, ackEntry, recoverChat });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-dead", messageId: "msg-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-dead", messageId: "msg-2" }));
    if (!startCtx || !startMessage || !startToken || !injectedMessage || !injectedToken) {
      throw new Error("expected captured start and inject state");
    }

    await startToken.complete(startMessage, { status: "success", terminal: true });
    injectedToken.retry(injectedMessage, "claude_retry_exhausted_tail_recovery");
    startCtx.failSessionForRecovery?.("claude_retry_exhausted", "session-id-mock");

    expect(sm.activeCount).toBe(0);
    expect(sm.getSessionRuntimeStates()).toEqual([]);

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-dead", messageId: "msg-2" }));
    expect(recoverChat).toHaveBeenCalledWith("chat-dead");
    expect(handler.resume).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-dead", messageId: "msg-2" }));

    expect(handler.inject).toHaveBeenCalledTimes(1);
    expect(handler.resume).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("routes the next message through resume after a terminal pre-turn failure evicts the handler", async () => {
    const ackEntry = mockAckEntry();
    let startCtx: SessionContext | undefined;
    let startMessage: SessionMessage | undefined;
    let startToken: DeliveryToken | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        startCtx = ctx;
        startMessage = message;
        startToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "processing" } as const };
      }),
      inject: vi.fn().mockReturnValue({ kind: "rejected", reason: "no_active_context", retryable: true } as const),
      resume: vi.fn(async () => {
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "processing" } as const };
      }),
    });
    const sm = createSessionManager({ handler, ackEntry });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-terminal", messageId: "msg-1" }));
    if (!startCtx || !startMessage || !startToken) throw new Error("expected captured start state");

    await startToken.complete(startMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });
    startCtx.failSessionForRecovery?.("provider_credential_required", "session-id-mock");

    expect(sm.activeCount).toBe(0);
    expect(handler.inject).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-terminal", messageId: "msg-2" }));

    expect(handler.inject).not.toHaveBeenCalled();
    expect(handler.resume).toHaveBeenCalledTimes(1);

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

  it("passes SessionContext with chatId and provider activity callback", async () => {
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
    expect(typeof capturedCtx?.recordProviderActivity).toBe("function");
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
    const contexts = new Map<string, SessionContext>();
    const messages = new Map<string, SessionMessage>();
    const factory: HandlerFactory = () => {
      const h = createMockHandler({
        async start(msg, ctx) {
          contexts.set(msg.chatId, ctx);
          messages.set(msg.chatId, msg);
          return `session-${msg.chatId}`;
        },
      });
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
    const firstCtx = contexts.get("chat-1");
    const firstMessage = messages.get("chat-1");
    if (!firstCtx || !firstMessage) throw new Error("chat-1 context missing");
    await firstCtx.finishTurn(firstMessage, { status: "success", terminal: true });

    // Third chat should evict the oldest idle session.
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-3" }));
    expect(sm.totalCount).toBe(2);

    await sm.shutdown();
  });

  it("resumes evicted session when new message arrives for same chat", async () => {
    const lifecycleCalls: Array<{ type: string; chatId: string; sessionId?: string }> = [];
    const contexts = new Map<string, SessionContext>();
    const messages = new Map<string, SessionMessage>();
    const factory: HandlerFactory = () =>
      createMockHandler({
        async start(msg, ctx) {
          const sid = `session-${msg.chatId}`;
          contexts.set(msg.chatId, ctx);
          messages.set(msg.chatId, msg);
          lifecycleCalls.push({ type: "start", chatId: msg.chatId });
          return sid;
        },
        async resume(msg, sessionId, ctx) {
          if (msg) {
            contexts.set(msg.chatId, ctx);
            messages.set(msg.chatId, msg);
          }
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
      recoverChat: vi.fn().mockResolvedValue(undefined),
    });

    // Fill up max_sessions
    const chat1 = mockEntry({ id: 1, chatId: "chat-1" });
    const chat2 = mockEntry({ id: 2, chatId: "chat-2" });
    const chat3 = mockEntry({ id: 3, chatId: "chat-3" });
    const chat4 = mockEntry({ id: 4, chatId: "chat-4" });
    const chat1Return = mockEntry({ id: 5, chatId: "chat-1" });
    await sm.dispatch(chat1);
    await sm.dispatch(chat1);
    await sm.dispatch(chat2);
    await sm.dispatch(chat2);
    expect(sm.totalCount).toBe(2);
    const chat1Ctx = contexts.get("chat-1");
    const chat1Msg = messages.get("chat-1");
    const chat2Ctx = contexts.get("chat-2");
    const chat2Msg = messages.get("chat-2");
    if (!chat1Ctx || !chat1Msg || !chat2Ctx || !chat2Msg) throw new Error("initial contexts missing");
    await chat1Ctx.finishTurn(chat1Msg, { status: "success", terminal: true });
    await chat2Ctx.finishTurn(chat2Msg, { status: "success", terminal: true });

    // Third chat evicts chat-1 (LRU)
    await sm.dispatch(chat3);
    await sm.dispatch(chat3);
    expect(sm.totalCount).toBe(2);

    // Fourth chat evicts chat-2
    await sm.dispatch(chat4);
    await sm.dispatch(chat4);
    expect(sm.totalCount).toBe(2);
    const chat3Ctx = contexts.get("chat-3");
    const chat3Msg = messages.get("chat-3");
    if (!chat3Ctx || !chat3Msg) throw new Error("chat-3 context missing");
    await chat3Ctx.finishTurn(chat3Msg, { status: "success", terminal: true });

    // Send a message to evicted chat-1: first dispatch triggers recovery,
    // second dispatch represents redelivery and should resume, not start.
    await sm.dispatch(chat1Return);
    await sm.dispatch(chat1Return);

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
    // `ctx.finishTurn(...)`. We close the turn here to exercise both halves
    // of the contract.
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

    await finishEntry(capturedCtx, 101, "grp-2");
    expect(ackEntry).toHaveBeenCalledWith(101);

    await sm.shutdown();
  });
});

/**
 * `ackEntry` is the WS data-plane ack callback wired from AgentSlot to
 * `clientConnection.sendInboxAck`. Post-inflight-message-recovery the
 * runtime defers acks: every entry sits in the delivery coordinator until
 * the handler calls `ctx.finishTurn(...)`, the runtime drains the queue
 * during a permanent failure / terminate teardown, or the next
 * `agent:bind` resets it server-side. Tests below pin the deferred-ack
 * contract for each entry-point dispatch can hit.
 */
describe("SessionManager ackEntry callback (deferred ack)", () => {
  function buildSm(
    ackEntry: (entryId: number) => Promise<void>,
    handler?: AgentHandler,
    recoverChat?: (chatId: string) => Promise<void>,
  ) {
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
      recoverChat,
    });
    return { sm, handler: h };
  }

  const unsafeErrorCompletions = [
    { name: "missing classification", outcome: { status: "error", terminal: true } },
    { name: "deterministic classification", outcome: { status: "error", terminal: true, errorKind: "deterministic" } },
    { name: "transient classification", outcome: { status: "error", terminal: true, errorKind: "transient" } },
    { name: "unknown classification", outcome: { status: "error", terminal: true, errorKind: "unknown" } },
  ] satisfies Array<{ name: string; outcome: TurnOutcome }>;

  it("starts a fresh chat without same-socket recovery even when recoverChat is configured", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const startSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({ start: startSpy });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-fresh", messageId: "msg-fresh" }));

    expect(recoverChat).not.toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("does not duplicate ACK-through when suspend races an ACK-pending finishTurn", async () => {
    const ack = deferred<void>();
    const ackEntry = vi.fn().mockReturnValue(ack.promise);
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const start = vi.fn(async (message: SessionMessage, ctx: SessionContext) => {
      capturedMessage = message;
      capturedCtx = ctx;
      return "session-id-mock";
    });
    const handler = createMockHandler({
      start,
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-ack-pending", messageId: "msg-ack-pending" }));
    if (!capturedCtx || !capturedMessage) throw new Error("message was not captured");

    const finish = capturedCtx.finishTurn(capturedMessage, { status: "success", terminal: true });
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledTimes(1));

    await sm.handleCommand("chat-ack-pending", "session:suspend");
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);

    ack.resolve(undefined);
    await finish;
    await Promise.resolve();
    expect(ackEntry).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("does not re-route same entryId redelivery while terminal ACK is pending", async () => {
    const ack = deferred<void>();
    const ackEntry = vi.fn().mockReturnValue(ack.promise);
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const start = vi.fn(async (message: SessionMessage, ctx: SessionContext) => {
      capturedMessage = message;
      capturedCtx = ctx;
      return "session-id-mock";
    });
    const handler = createMockHandler({
      start,
    });
    const { sm } = buildSm(ackEntry, handler);
    const entry = mockEntry({ id: 77, chatId: "chat-terminal-redelivery", messageId: "msg-terminal" });

    await sm.dispatch(entry);
    if (!capturedCtx || !capturedMessage) throw new Error("message was not captured");

    const finish = capturedCtx.finishTurn(capturedMessage, { status: "success", terminal: true });
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledTimes(1));

    await sm.dispatch(entry);

    expect(start).toHaveBeenCalledTimes(1);
    expect(handler.inject).not.toHaveBeenCalled();
    expect(ackEntry).toHaveBeenCalledTimes(1);

    ack.resolve(undefined);
    await finish;
    await sm.shutdown();
  });

  it("requests chat recovery when concurrency preemption interrupts owed work", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const startSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({ start: startSpy });
    const sm = createSessionManager({
      ackEntry,
      handler,
      recoverChat,
      concurrency: 1,
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-preempted", messageId: "msg-preempted" }));
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-new-slot", messageId: "msg-new-slot" }));

    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(recoverChat).toHaveBeenCalledWith("chat-preempted");
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("uses an idle active session before preempting a working session for concurrency", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const events: Array<{ chatId: string; event: SessionEvent }> = [];
    const handlers = new Map<string, AgentHandler>();
    const contexts = new Map<string, SessionContext>();
    const messages = new Map<string, SessionMessage>();
    const factory: HandlerFactory = () => {
      let current: AgentHandler;
      current = createMockHandler({
        async start(message, ctx) {
          handlers.set(message.chatId, current);
          contexts.set(message.chatId, ctx);
          messages.set(message.chatId, message);
          ctx.markMessagesConsumed(message);
          return `session-${message.chatId}`;
        },
      });
      return current;
    };
    const sm = createSessionManager({
      ackEntry,
      handlerFactory: factory,
      onSessionEvent: (chatId, event) => events.push({ chatId, event }),
      concurrency: 2,
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-working", messageId: "msg-working" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-idle", messageId: "msg-idle" }));
    const idleCtx = contexts.get("chat-idle");
    const idleMessage = messages.get("chat-idle");
    if (!idleCtx || !idleMessage) throw new Error("idle context missing");
    await idleCtx.finishTurn(idleMessage, { status: "success", terminal: true });

    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-new", messageId: "msg-new" }));

    await vi.waitFor(() => expect(handlers.get("chat-idle")?.suspend).toHaveBeenCalledTimes(1));
    expect(handlers.get("chat-working")?.suspend).not.toHaveBeenCalled();
    expect(handlers.has("chat-new")).toBe(true);
    expect(ackEntry).toHaveBeenCalledWith(2);
    expect(
      events.some(
        ({ chatId, event }) =>
          chatId === "chat-idle" &&
          event.kind === "error" &&
          event.payload.source === "runtime" &&
          event.payload.message.includes("resilience.session.preempted:") &&
          event.payload.message.includes("concurrency_idle_yield"),
      ),
    ).toBe(false);

    await sm.shutdown();
  });

  it("ack waits for finishTurn when starting a new session", async () => {
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

    await finishEntry(capturedCtx, 1, "chat-1");
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(1);

    await sm.shutdown();
  });

  it("finishTurn(message) acks through the concrete consumed entry only", async () => {
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
        return { kind: "owned", mode: "queued" } as const;
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-1" }));

    expect(ackEntry).not.toHaveBeenCalled();

    // First turn closes — ack entry #1 only.
    if (firstMessage) await capturedCtx?.finishTurn(firstMessage, { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(1);

    // Second turn closes — ack entry #2.
    if (injected[0]) await capturedCtx?.finishTurn(injected[0], { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenCalledTimes(2);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 2);

    await sm.shutdown();
  });

  it("finishTurn(batch) sends one ack-through for the batch tail", async () => {
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
        return { kind: "owned", mode: "queued" } as const;
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 10, chatId: "chat-codex" }));
    await sm.dispatch(mockEntry({ id: 11, chatId: "chat-codex" }));
    await sm.dispatch(mockEntry({ id: 12, chatId: "chat-codex" }));
    expect(ackEntry).not.toHaveBeenCalled();

    // First turn (just message 10).
    if (firstMessage) await capturedCtx?.finishTurn(firstMessage, { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(10);

    // Fused turn (messages 11 + 12 batched into one runTurn).
    await capturedCtx?.finishTurn(injected, { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenCalledTimes(2);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 12);

    await sm.shutdown();
  });

  it("finishTurn ignores stale messages that are no longer tracked", async () => {
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
    if (capturedMessage) await capturedCtx?.finishTurn(capturedMessage, { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(20);

    if (capturedMessage) await capturedCtx?.finishTurn(capturedMessage, { status: "success", terminal: true });
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
      updateSdk: vi.fn(),
      updateUrls: vi.fn(),
      allReferencedUrls: vi.fn(() => new Set<string>()),
      forget: vi.fn(),
    };
    const routed: string[] = [];
    const injected: Parameters<AgentHandler["inject"]>[0][] = [];
    let capturedCtx: SessionContext | undefined;
    let startedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      async start(m, ctx) {
        routed.push(`start:${m.id}`);
        capturedCtx = ctx;
        startedMessage = m;
        return "session-id-mock";
      },
      inject: vi.fn((m) => {
        routed.push(`inject:${m.id}`);
        injected.push(m);
        return { kind: "owned", mode: "queued" } as const;
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

    if (!startedMessage || !injected[0] || !capturedCtx) throw new Error("messages were not captured");
    await capturedCtx.finishTurn([startedMessage, injected[0]], { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(2);

    await sm.shutdown();
  });

  it("requests chat recovery when routeMessage fails and lets later redelivery route", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
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
      recoverChat,
    });

    const first = mockEntry({ id: 1, chatId: "chat-route-fail", messageId: "msg-a1" });
    await expect(sm.dispatch(first)).rejects.toThrow("handler factory offline");
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-route-fail", messageId: "msg-a2" }));
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(recoveryStart).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("manual suspend resolves processingStarted entries and lets later input resume", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const resumeSpy = vi.fn(async () => "session-id-mock");
    const startSpy = vi.fn(async (m: Parameters<AgentHandler["start"]>[0], ctx: SessionContext) => {
      firstMessage = m;
      capturedCtx = ctx;
      return "session-id-mock";
    });
    const handler = createMockHandler({
      start: startSpy,
      resume: resumeSpy,
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    const first = mockEntry({ id: 30, chatId: "chat-suspend", messageId: "msg-a1" });
    await sm.dispatch(first);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledTimes(1);

    if (firstMessage) capturedCtx?.markMessagesConsumed(firstMessage);
    await sm.handleCommand("chat-suspend", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(30));
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 31, chatId: "chat-suspend", messageId: "msg-a2" }));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(ackEntry).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("manual suspend settlement wins the race with immediate later input", async () => {
    const ack = deferred<void>();
    const ackEntry = vi.fn().mockReturnValueOnce(ack.promise).mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const resumeSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      resume: resumeSpy,
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 35, chatId: "chat-suspend-race", messageId: "msg-race-1" }));
    if (firstMessage) capturedCtx?.markMessagesConsumed(firstMessage);

    await sm.handleCommand("chat-suspend-race", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(35));

    const laterDispatch = sm.dispatch(mockEntry({ id: 36, chatId: "chat-suspend-race", messageId: "msg-race-2" }));
    await Promise.resolve();
    expect(recoverChat).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();

    ack.resolve(undefined);
    await laterDispatch;

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("manual suspend defers recovery for injected but not consumed entries", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const injected: Parameters<AgentHandler["inject"]>[0][] = [];
    const resumeSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      resume: resumeSpy,
      inject: vi.fn((m) => {
        injected.push(m);
        return { kind: "owned", mode: "queued" } as const;
      }),
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    const first = mockEntry({ id: 32, chatId: "chat-suspend-queue", messageId: "msg-q1" });
    await sm.dispatch(first);
    if (firstMessage) capturedCtx?.markMessagesConsumed(firstMessage);

    await sm.dispatch(mockEntry({ id: 33, chatId: "chat-suspend-queue", messageId: "msg-q2" }));
    expect(injected).toHaveLength(1);

    await sm.handleCommand("chat-suspend-queue", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(32));
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalledWith(33);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 34, chatId: "chat-suspend-queue", messageId: "msg-q3" }));
    expect(recoverChat).toHaveBeenCalledWith("chat-suspend-queue");
    expect(resumeSpy).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 33, chatId: "chat-suspend-queue", messageId: "msg-q2" }));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("explicit resume requests recovery when manual suspend left deferred debt", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const resumeSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      resume: resumeSpy,
      inject: vi.fn(() => ({ kind: "owned", mode: "queued" }) as const),
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 37, chatId: "chat-resume-debt", messageId: "msg-rd-1" }));
    if (firstMessage) capturedCtx?.markMessagesConsumed(firstMessage);
    await sm.dispatch(mockEntry({ id: 38, chatId: "chat-resume-debt", messageId: "msg-rd-2" }));

    await sm.handleCommand("chat-resume-debt", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(37));

    await sm.handleCommand("chat-resume-debt", "session:resume");
    expect(recoverChat).toHaveBeenCalledWith("chat-resume-debt");
    expect(resumeSpy).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 38, chatId: "chat-resume-debt", messageId: "msg-rd-2" }));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalledWith(38);

    await sm.shutdown();
  });

  it("explicit resume waits for in-flight manual suspend before checking deferred debt", async () => {
    const ack = deferred<void>();
    const ackEntry = vi.fn().mockReturnValueOnce(ack.promise).mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const resumeSpy = vi.fn(async () => "session-id-mock");
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      resume: resumeSpy,
      inject: vi.fn(() => ({ kind: "owned", mode: "queued" }) as const),
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 39, chatId: "chat-resume-suspend-race", messageId: "msg-rsr-1" }));
    if (firstMessage) capturedCtx?.markMessagesConsumed(firstMessage);
    await sm.dispatch(mockEntry({ id: 40, chatId: "chat-resume-suspend-race", messageId: "msg-rsr-2" }));

    await sm.handleCommand("chat-resume-suspend-race", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(39));

    const resume = sm.handleCommand("chat-resume-suspend-race", "session:resume");
    await Promise.resolve();
    expect(recoverChat).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();

    ack.resolve(undefined);
    await resume;

    expect(recoverChat).toHaveBeenCalledWith("chat-resume-suspend-race");
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalledWith(40);

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
        return { kind: "owned", mode: "queued" } as const;
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 40, chatId: "chat-retryable", messageId: "msg-a1" }));
    await sm.dispatch(mockEntry({ id: 41, chatId: "chat-retryable", messageId: "msg-a2" }));

    if (firstMessage) capturedCtx?.retryTurn(firstMessage, "turn_timeout");
    if (injected[0]) capturedCtx?.finishTurn(injected[0], { status: "success", terminal: true });
    await Promise.resolve();

    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("retryable no-ack requests recovery and blocks newer input until recovery settles", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recovery = deferred<void>();
    const recoverChat = vi.fn().mockReturnValue(recovery.promise);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const injectSpy = vi.fn();
    const startSpy = vi.fn(async (m: Parameters<AgentHandler["start"]>[0], ctx: SessionContext) => {
      firstMessage = m;
      capturedCtx = ctx;
      return "session-id-mock";
    });
    const handler = createMockHandler({
      start: startSpy,
      inject: injectSpy,
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    const first = mockEntry({ id: 42, chatId: "chat-retryable-recover", messageId: "msg-r1" });
    await sm.dispatch(first);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledTimes(1);

    if (firstMessage) capturedCtx?.retryTurn(firstMessage, "turn_timeout");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));

    const newer = sm.dispatch(mockEntry({ id: 43, chatId: "chat-retryable-recover", messageId: "msg-r2" }));
    await Promise.resolve();
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(injectSpy).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();
    recovery.resolve(undefined);
    await newer;

    await sm.dispatch(mockEntry({ id: 43, chatId: "chat-retryable-recover", messageId: "msg-r2" }));
    expect(injectSpy).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("keeps recovery debt after recovery failure and retries on later dispatch", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockRejectedValueOnce(new Error("recover offline")).mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const injectSpy = vi.fn();
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      inject: injectSpy,
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 50, chatId: "chat-recover-fail", messageId: "msg-fail-1" }));
    if (firstMessage) capturedCtx?.retryTurn(firstMessage, "turn_timeout");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    await sm.dispatch(mockEntry({ id: 51, chatId: "chat-recover-fail", messageId: "msg-fail-2" }));
    expect(recoverChat).toHaveBeenCalledTimes(2);
    expect(injectSpy).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 51, chatId: "chat-recover-fail", messageId: "msg-fail-2" }));
    expect(injectSpy).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("fails closed when recovery is required but recoverChat is not configured", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let firstMessage: Parameters<AgentHandler["start"]>[0] | undefined;
    const injectSpy = vi.fn();
    const handler = createMockHandler({
      async start(m, ctx) {
        firstMessage = m;
        capturedCtx = ctx;
        return "session-id-mock";
      },
      inject: injectSpy,
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 44, chatId: "chat-retryable-no-recover", messageId: "msg-nr1" }));
    if (firstMessage) capturedCtx?.retryTurn(firstMessage, "turn_timeout");

    await sm.dispatch(mockEntry({ id: 45, chatId: "chat-retryable-no-recover", messageId: "msg-nr2" }));
    expect(injectSpy).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("ack waits for finishTurn when resuming an evicted session", async () => {
    // Seed an evicted session by exceeding concurrency=1, then dispatch into
    // the evicted chat to trigger the resume branch.
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
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
      recoverChat,
    });

    // Start chat-a, then chat-b which evicts chat-a (max_sessions=1).
    const chatA = mockEntry({ id: 1, chatId: "chat-a" });
    const chatB = mockEntry({ id: 2, chatId: "chat-b" });
    await sm.dispatch(chatA);
    await sm.dispatch(chatA);
    await finishEntry(capturedCtxs[0], 1, "chat-a");
    await sm.dispatch(chatB);
    await sm.dispatch(chatB);
    // Close chat-a and chat-b's start turns so their entries don't pollute
    // the resume-branch ack assertion.
    await finishEntry(capturedCtxs[1], 2, "chat-b");
    ackEntry.mockClear();

    // Dispatching back into chat-a first triggers chat-scoped recovery; the
    // redelivered frame then hits the resume branch.
    const chatAResume = mockEntry({ id: 3, chatId: "chat-a", messageId: "msg-resume" });
    await sm.dispatch(chatAResume);
    await sm.dispatch(chatAResume);
    expect(ackEntry).not.toHaveBeenCalled();

    await finishEntry(capturedCtxs[2], 3, "chat-a", "msg-resume");
    expect(ackEntry).toHaveBeenCalledWith(3);

    await sm.shutdown();
  });

  it("does not ACK permanent handler.start failure without durable terminal evidence", async () => {
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
    // Session events alone are not durable terminal evidence, so the
    // delivery remains unacked for recovery instead of being eaten.
    await Promise.resolve();
    await Promise.resolve();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("ACKs terminalRejected only after durable evidence is reported", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, _ctx, token) => {
        capturedMessage = message;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 8, chatId: "chat-terminal-rejected", messageId: "msg-terminal-rejected" }));
    expect(ackEntry).not.toHaveBeenCalled();
    if (!capturedToken || !capturedMessage) throw new Error("delivery token was not captured");

    await capturedToken.terminalRejected(capturedMessage, "deterministic_pre_provider_failure", {
      kind: "chat_message",
      messageId: "error-message-id",
    });

    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(8);

    await sm.shutdown();
  });

  it.each(unsafeErrorCompletions)("does not ACK token.complete(error) with $name", async ({ outcome }) => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, _ctx, token) => {
        capturedMessage = message;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 18, chatId: "chat-token-error", messageId: "msg-token-error" }));
    if (!capturedToken || !capturedMessage) throw new Error("delivery token was not captured");

    await capturedToken.complete(capturedMessage, outcome);

    expect(ackEntry).not.toHaveBeenCalled();
    expect(recoverChat).toHaveBeenCalledWith("chat-token-error");

    await sm.shutdown();
  });

  it("ACKs explicit consumed error completion", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, _ctx, token) => {
        capturedMessage = message;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 19, chatId: "chat-consumed-error", messageId: "msg-consumed-error" }));
    if (!capturedToken || !capturedMessage) throw new Error("delivery token was not captured");

    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_clean_error",
    });

    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(19);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("posts a durable runtime notice before ACKing a terminal provider failure", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    } as unknown as FirstTreeHubSDK;
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      sdk,
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    });

    await sm.dispatch(mockEntry({ id: 21, chatId: "chat-provider-terminal", messageId: "msg-provider-terminal" }));
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery was not captured");

    emitCodexTerminalProviderFailure(
      capturedCtx,
      "Your access token could not be refreshed because your refresh token was revoked.",
    );
    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "chat-provider-terminal",
      expect.objectContaining({
        source: "api",
        format: "text",
        metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true },
        purpose: "agent-final-text",
      }),
    );
    const notice = String(sendMessage.mock.calls[0]?.[1].content);
    expect(notice).toContain("Codex could not run this turn");
    expect(notice).toContain("credentials need attention");
    expect(notice).toContain("refresh token was revoked");
    expect(ackEntry).toHaveBeenCalledWith(21);
    const [noticeOrder] = sendMessage.mock.invocationCallOrder;
    const [ackOrder] = ackEntry.mock.invocationCallOrder;
    if (noticeOrder === undefined || ackOrder === undefined) throw new Error("expected notice and ack order");
    expect(noticeOrder).toBeLessThan(ackOrder);

    await sm.shutdown();
  });

  it("posts a durable runtime notice before ACKing a Codex retry-exhausted turn once", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    } as unknown as FirstTreeHubSDK;
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      sdk,
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    });

    await sm.dispatch(
      mockEntry({ id: 27, chatId: "chat-codex-retry-exhausted", messageId: "msg-codex-retry-exhausted" }),
    );
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery was not captured");

    emitCodexRetryExhausted(capturedCtx, "Selected model is at capacity. Please try a different model.");
    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_retry_exhausted",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(27);
    const [noticeOrder] = sendMessage.mock.invocationCallOrder;
    const [ackOrder] = ackEntry.mock.invocationCallOrder;
    if (noticeOrder === undefined || ackOrder === undefined) throw new Error("expected notice and ack order");
    expect(noticeOrder).toBeLessThan(ackOrder);

    await sm.shutdown();
  });

  it("posts a durable runtime notice for Claude provider-turn terminal failures", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    } as unknown as FirstTreeHubSDK;
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      sdk,
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "claude-code" },
    });

    await sm.dispatch(mockEntry({ id: 24, chatId: "chat-claude-terminal", messageId: "msg-claude-terminal" }));
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery was not captured");

    emitClaudeProviderFailure(capturedCtx, {
      category: "credential",
      reasonCode: "provider_credential_required",
      messagePreview: "Failed to authenticate. API Error: 403 Request not allowed",
    });
    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const notice = String(sendMessage.mock.calls[0]?.[1].content);
    expect(notice).toContain("Claude Code could not run this turn");
    expect(notice).toContain("before authentication");
    expect(notice).toContain("daemon.env");
    expect(notice).not.toContain("rejected the local Claude authentication");
    expect(ackEntry).toHaveBeenCalledWith(24);
    const [noticeOrder] = sendMessage.mock.invocationCallOrder;
    const [ackOrder] = ackEntry.mock.invocationCallOrder;
    if (noticeOrder === undefined || ackOrder === undefined) throw new Error("expected notice and ack order");
    expect(noticeOrder).toBeLessThan(ackOrder);

    await sm.shutdown();
  });

  it("posts a durable runtime notice for Claude retry-exhausted provider-turn failures", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    } as unknown as FirstTreeHubSDK;
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      sdk,
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "claude-code" },
    });

    await sm.dispatch(
      mockEntry({ id: 25, chatId: "chat-claude-retry-exhausted", messageId: "msg-claude-retry-exhausted" }),
    );
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery was not captured");

    emitClaudeProviderFailure(capturedCtx, {
      event: "provider_retry_exhausted",
      category: "transient_transport",
      reasonCode: "claude_sdk_error_exhausted",
      messagePreview: "socket connection was closed unexpectedly",
    });
    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "retry_exhausted_notice_posted",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const notice = String(sendMessage.mock.calls[0]?.[1].content);
    expect(notice).toContain("provider API connection failed after retry handling");
    expect(notice).toContain("socket connection was closed unexpectedly");
    expect(ackEntry).toHaveBeenCalledWith(25);

    await sm.shutdown();
  });

  it("posts a durable runtime notice before ACKing Claude auto-resume failures", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    } as unknown as FirstTreeHubSDK;
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      sdk,
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "claude-code" },
    });

    await sm.dispatch(
      mockEntry({ id: 26, chatId: "chat-claude-auto-resume-failed", messageId: "msg-claude-auto-resume-failed" }),
    );
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery was not captured");

    emitClaudeProviderFailure(capturedCtx, {
      category: "transient_transport",
      reasonCode: "claude_auto_resume_failed",
      messagePreview: "initial sdk transport crash\nAuto-resume failed: respawn build failed: sdk module unavailable",
    });
    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "auto_resume_failed_notice_posted",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const notice = String(sendMessage.mock.calls[0]?.[1].content);
    expect(notice).toContain("provider API connection failed after retry handling");
    expect(notice).toContain("initial sdk transport crash");
    expect(notice).toContain("respawn build failed");
    expect(ackEntry).toHaveBeenCalledWith(26);
    const [noticeOrder] = sendMessage.mock.invocationCallOrder;
    const [ackOrder] = ackEntry.mock.invocationCallOrder;
    if (noticeOrder === undefined || ackOrder === undefined) throw new Error("expected notice and ack order");
    expect(noticeOrder).toBeLessThan(ackOrder);

    await sm.shutdown();
  });

  it("does not ACK a terminal provider failure when the durable runtime notice cannot be posted", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    } as unknown as FirstTreeHubSDK;
    const emitted: SessionEvent[] = [];
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      recoverChat,
      sdk,
      onSessionEvent: (_chatId, event) => emitted.push(event),
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    });

    await sm.dispatch(
      mockEntry({ id: 22, chatId: "chat-provider-notice-fail", messageId: "msg-provider-notice-fail" }),
    );
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery was not captured");

    emitCodexTerminalProviderFailure(capturedCtx, "revoked refresh token");
    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalled();
    expect(recoverChat).toHaveBeenCalledWith("chat-provider-notice-fail");
    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "runtime" &&
          event.payload.message.includes("runtime failure notice delivery failed"),
      ),
    ).toBe(true);
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({ id: "later-runtime-notice" });
    await capturedCtx.finishTurn(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "forward_failed",
    });
    expect(sendMessage).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("clears stale terminal provider notices when the delivery is retried instead of consumed", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    } as unknown as FirstTreeHubSDK;
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionManager({
      handler,
      ackEntry,
      sdk,
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    });

    await sm.dispatch(mockEntry({ id: 23, chatId: "chat-provider-retry", messageId: "msg-provider-retry" }));
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery was not captured");

    emitCodexTerminalProviderFailure(capturedCtx, "pre-provider retry exhausted");
    capturedToken.retry(capturedMessage, "provider_retry_exhausted_pre_provider");

    await capturedCtx.finishTurn(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "forward_failed",
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("applies the same error completion guard to legacy ctx.finishTurn", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx) => {
        capturedMessage = message;
        capturedCtx = ctx;
        return "session-id-mock";
      }),
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 20, chatId: "chat-legacy-error", messageId: "msg-legacy-error" }));
    if (!capturedCtx || !capturedMessage) throw new Error("session context was not captured");

    await capturedCtx.finishTurn(capturedMessage, { status: "error", terminal: true });

    expect(ackEntry).not.toHaveBeenCalled();
    expect(recoverChat).toHaveBeenCalledWith("chat-legacy-error");

    await sm.shutdown();
  });

  it("ignores duplicate terminal outcomes from the same delivery token", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, _ctx, token) => {
        capturedMessage = message;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const { sm } = buildSm(ackEntry, handler, recoverChat);

    await sm.dispatch(mockEntry({ id: 9, chatId: "chat-token-once", messageId: "msg-token-once" }));
    if (!capturedToken || !capturedMessage) throw new Error("delivery token was not captured");

    await capturedToken.complete(capturedMessage, { status: "success", terminal: true });
    capturedToken.retry(capturedMessage, "late_retry");

    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(9);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("does NOT ack on transient handler.start failure — retry path keeps the entry queued for forwardResult", async () => {
    // A 429-ish error is classified as transient; the runtime schedules a
    // retry inside `handleSessionFailure` and leaves the entry queued so
    // the eventual successful retry can ack it via finishTurn.
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

  it("does not ACK queued non-terminal entries on session:terminate", async () => {
    const ackEntry = vi.fn().mockResolvedValue(undefined);
    // Handler whose `start` resolves quickly (matching production: start
    // returns the sessionId; the turn closes later via finishTurn).
    // finishTurn is NEVER called by this mock, so the entry stays tracked
    // past the turn — exactly what terminate needs to
    // ack so the next bind doesn't redeliver.
    const handler = createMockHandler();
    const { sm } = buildSm(ackEntry, handler);

    await sm.dispatch(mockEntry({ id: 11, chatId: "chat-term" }));
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.handleCommand("chat-term", "session:terminate");
    await Promise.resolve();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });
});

describe("SessionManager lazy Context Tree binding", () => {
  const BINDING: ContextTreeBinding = {
    path: "/clones/abc",
    repoUrl: "https://github.com/acme/context-tree",
    branch: "main",
  };

  it("upgrades a tree-less handler config to tree-bound on a new session", async () => {
    const handlerConfig: HandlerConfig = { workspaceRoot: "/tmp/test" };
    let builtWith: HandlerConfig | undefined;
    const sm = createSessionManager({
      handlerConfig,
      handlerFactory: (cfg) => {
        builtWith = cfg;
        return createMockHandler();
      },
      resolveContextTreeBinding: async () => BINDING,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "c-bind", messageId: "m1" }));

    // Patched in place...
    expect(handlerConfig.contextTreePath).toBe("/clones/abc");
    expect(handlerConfig.contextTreeRepoUrl).toBe("https://github.com/acme/context-tree");
    expect(handlerConfig.contextTreeBranch).toBe("main");
    // ...so the handler for the new session is built tree-bound.
    expect(builtWith?.contextTreePath).toBe("/clones/abc");

    await sm.shutdown();
  });

  it("does not re-resolve when already bound (steady state pays nothing)", async () => {
    const resolve = vi.fn(async () => BINDING);
    const handlerConfig: HandlerConfig = { workspaceRoot: "/tmp/test", contextTreePath: "/already/bound" };
    const sm = createSessionManager({ handlerConfig, resolveContextTreeBinding: resolve });

    await sm.dispatch(mockEntry({ id: 1, chatId: "c-bound", messageId: "m1" }));

    expect(resolve).not.toHaveBeenCalled();
    expect(handlerConfig.contextTreePath).toBe("/already/bound");

    await sm.shutdown();
  });

  it("re-resolves once for the new session, not again for a same-chat inject", async () => {
    const resolve = vi.fn(async () => null);
    const handlerConfig: HandlerConfig = { workspaceRoot: "/tmp/test" };
    const sm = createSessionManager({ handlerConfig, resolveContextTreeBinding: resolve });

    await sm.dispatch(mockEntry({ id: 1, chatId: "c-once", messageId: "m1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "c-once", messageId: "m2" }));

    expect(resolve).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });
});

describe("SessionManager subprocess-aware suspend/eviction", () => {
  it("defers idle-suspend while the provider has a live subprocess, then suspends once it clears", async () => {
    vi.useFakeTimers();
    try {
      let ctx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, c) {
          ctx = c;
          return "sid";
        },
      });
      const hasLive = vi.fn().mockReturnValue(true);
      const probe: SubprocessProbe = { hasLiveSubprocess: hasLive, stop: vi.fn() };
      const sm = createSessionManager({
        handler,
        subprocessProbe: probe,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 100, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
      await finishEntry(ctx, 1, "chat-1");

      // Past idle_timeout (1s) but well under the hard cap (1 + 100s): the live
      // subprocess keeps the session active.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handler.suspend).not.toHaveBeenCalled();

      // Subprocess gone -> the next idle tick suspends as usual.
      hasLive.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(handler.suspend).toHaveBeenCalledTimes(1);

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends past the idle_timeout + working_grace hard cap even with a live subprocess", async () => {
    vi.useFakeTimers();
    try {
      let ctx: SessionContext | undefined;
      const handler = createMockHandler({
        async start(_msg, c) {
          ctx = c;
          return "sid";
        },
      });
      const probe: SubprocessProbe = { hasLiveSubprocess: vi.fn().mockReturnValue(true), stop: vi.fn() };
      const sm = createSessionManager({
        handler,
        subprocessProbe: probe,
        // Hard cap = idle_timeout(1) + working_grace(2) = 3s.
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 2, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
      await finishEntry(ctx, 1, "chat-1");

      await vi.advanceTimersByTimeAsync(15_000);
      expect(handler.suspend).toHaveBeenCalledTimes(1);

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers an idle session without a live subprocess as the concurrency-yield victim", async () => {
    const handlers: AgentHandler[] = [];
    const ctxs: Record<string, SessionContext> = {};
    const factory: HandlerFactory = () => {
      const h = createMockHandler({
        async start(msg, c) {
          ctxs[(msg as { chatId: string }).chatId] = c;
          return `sid-${(msg as { chatId: string }).chatId}`;
        },
      });
      handlers.push(h);
      return h;
    };
    // chat-1 has a live watcher; chat-2 does not.
    const probe: SubprocessProbe = {
      hasLiveSubprocess: vi.fn((chatId: string) => chatId === "chat-1"),
      stop: vi.fn(),
    };
    const sm = createSessionManager({ handlerFactory: factory, concurrency: 2, subprocessProbe: probe });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-1" }));
    await finishEntry(ctxs["chat-1"], 1, "chat-1");
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-2" }));
    await finishEntry(ctxs["chat-2"], 2, "chat-2");

    // Slots full (concurrency 2), both idle. chat-1 is older, so the old logic
    // would yield it — but it has a live subprocess, so chat-2 must yield.
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-3" }));

    expect(handlers[0]?.suspend).not.toHaveBeenCalled();
    expect(handlers[1]?.suspend).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });
});
