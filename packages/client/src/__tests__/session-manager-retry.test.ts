import { parseProviderRetryEventMessage, type SessionEvent, type SessionState } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/**
 * Bug 1 fix (client-resilience-design §5.1): a transient-classified failure
 * during handler.start / handler.resume keeps the SessionEntry around with a
 * scheduled retry rather than deleting it. Permanent failures still go
 * through the legacy F2 teardown path.
 */

function mockSdk(): { sdk: FirstTreeHubSDK; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue({ id: "msg-reply" });
  const listChatParticipants = vi.fn().mockResolvedValue([]);
  return {
    sdk: {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      listChatParticipants,
    } as unknown as FirstTreeHubSDK,
    sendMessage,
  };
}

function makeManager(opts: {
  handlers: AgentHandler[];
  ackEntry?: (entryId: number) => Promise<void>;
  recoverChat?: (chatId: string) => Promise<void>;
  onStateChange?: (chatId: string, state: SessionState) => void;
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
}): SessionManager {
  const factory: HandlerFactory = () => {
    const next = opts.handlers.shift();
    if (!next) throw new Error("handler factory exhausted");
    return next;
  };
  return new SessionManager({
    session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    concurrency: 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test-retry" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Test Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: mockSdk().sdk,
    log: silentLogger(),
    ackEntry: opts.ackEntry ?? vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    recoverChat: opts.recoverChat,
    onStateChange: opts.onStateChange,
    onSessionEvent: opts.onSessionEvent,
  });
}

class FakeRateLimit extends Error {
  override name = "RateLimitError";
  status = 429;
}

describe("SessionManager: transient session retry", () => {
  it("keeps the entry alive and schedules a retry on RateLimitError", async () => {
    const handler: AgentHandler = {
      start: vi.fn().mockRejectedValue(new FakeRateLimit("rate limited")),
      resume: vi.fn().mockResolvedValue("session-after-retry"),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const stateChanges: SessionState[] = [];
    const sm = makeManager({
      handlers: [handler],
      onStateChange: (_chat, state) => stateChanges.push(state),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-rate" }));

    // First report is `active` (pre-start); retry path does NOT emit `errored`
    // because we did not classify this as permanent.
    expect(stateChanges).toEqual(["active"]);

    // No "Session start failed" event was forwarded as a structured error to
    // the chat — transient retries stay silent so the user does not see
    // intermediate failures.
    // SessionManager state should still hold the entry so a user message can
    // trigger an immediate retry.
    expect(sm.totalCount).toBe(1);

    await sm.shutdown();
  });

  it("permanent error still removes the entry (legacy F2 path)", async () => {
    class FakeAuthRejected extends Error {
      override name = "ClientUserMismatchError";
    }
    const handler: AgentHandler = {
      start: vi.fn().mockRejectedValue(new FakeAuthRejected("nope")),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const events: SessionEvent[] = [];
    const stateChanges: SessionState[] = [];
    const sm = makeManager({
      handlers: [handler],
      onStateChange: (_chat, state) => stateChanges.push(state),
      onSessionEvent: (_chat, ev) => events.push(ev),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-perm" }));

    expect(stateChanges).toEqual(["active", "errored"]);
    expect(sm.totalCount).toBe(0);
    expect(events.some((e) => e.kind === "error")).toBe(true);

    await sm.shutdown();
  });

  it("retry_scheduled event payload carries the raw err.message for operator diagnosis", async () => {
    // Surfacing the underlying err.message into the resilience event payload
    // is the only way the web UI (or an operator tailing the log) can see the
    // actual cause for a `reasonCode:"unknown"` / `git_unknown` transient. The
    // reasonCode alone is not actionable on those buckets — see the prod
    // incident motivating the git-error classification PR.
    const handler: AgentHandler = {
      start: vi.fn().mockRejectedValue(new FakeRateLimit("upstream rate limited — please retry shortly")),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const events: SessionEvent[] = [];
    const sm = makeManager({
      handlers: [handler],
      onSessionEvent: (_chat, ev) => events.push(ev),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-raw-error" }));

    const errorEvents = events.filter((e) => e.kind === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
    const scheduled = errorEvents.find(
      (e) =>
        typeof e.payload.message === "string" &&
        parseProviderRetryEventMessage(e.payload.message)?.event === "provider_retry_scheduled",
    );
    expect(scheduled).toBeDefined();
    const message = scheduled?.payload.message;
    if (typeof message !== "string") throw new Error("Expected string provider retry payload");
    const parsed = parseProviderRetryEventMessage(message);
    expect(parsed?.reasonCode).toBe("provider_rate_limited");
    expect(parsed?.attempt).toBe(1);
    expect(parsed?.scope).toBe("session_start");
    expect(parsed?.messagePreview).toBe("upstream rate limited — please retry shortly");

    await sm.shutdown();
  });

  it("retry_scheduled rawError is REDACTED — credentials in err.message never reach the chat event", async () => {
    // Regression guard for the Codex P1 finding on PR #975: an
    // `agentRuntimeConfig.gitRepos[].url` carrying a PAT or basic-auth
    // pair (the runtime schema is `z.string().min(1)`, not the stricter
    // org-settings repoUrlSchema) gets echoed back by git verbatim in the
    // resulting `GitMirrorError` message. Surfacing that into a chat-visible
    // event would leak the credential. `redactErrorPreview` is the boundary —
    // this test pins it end-to-end so a future refactor can't drop the
    // sanitisation call and pass unit tests in isolation.
    const handler: AgentHandler = {
      start: vi
        .fn()
        .mockRejectedValue(
          new FakeRateLimit(
            "git clone https://user:ghp_AbCdEf0123456789abcdef0123456789abcd@github.com/acme/private.git exited with code 128",
          ),
        ),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const events: SessionEvent[] = [];
    const sm = makeManager({
      handlers: [handler],
      onSessionEvent: (_chat, ev) => events.push(ev),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-redact" }));

    const scheduled = events.find(
      (e): e is Extract<SessionEvent, { kind: "error" }> =>
        e.kind === "error" &&
        typeof e.payload.message === "string" &&
        parseProviderRetryEventMessage(e.payload.message)?.event === "provider_retry_scheduled",
    );
    expect(scheduled).toBeDefined();
    const encoded = scheduled?.payload.message ?? "";
    // The PAT must not appear anywhere in the chat-visible payload.
    expect(encoded).not.toContain("ghp_AbCdEf0123456789abcdef0123456789abcd");
    expect(encoded).not.toContain("user:ghp_");
    // The redacted form should still leave the repo host/path so an operator
    // can tell which clone failed.
    expect(encoded).toContain("github.com/acme/private.git");
    expect(encoded).toContain("[REDACTED]");

    await sm.shutdown();
  });

  it("user message during retry window triggers an immediate retry", async () => {
    const failing: AgentHandler = {
      start: vi.fn().mockRejectedValue(new FakeRateLimit("rate limited")),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const recovered: AgentHandler = {
      start: vi.fn().mockResolvedValue("session-after-retry"),
      resume: vi.fn().mockResolvedValue("session-after-retry"),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const sm = makeManager({ handlers: [failing, recovered] });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-imm" }));
    // Entry survives transient failure.
    expect(sm.totalCount).toBe(1);

    // Second dispatch with retry pending: should trigger immediate retry,
    // which builds a fresh handler from the factory (recovered).
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-imm" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // First handler.start rejected (transient), so no claudeSessionId was
    // captured. The retry path falls back to start() on the new handler.
    expect(recovered.start).toHaveBeenCalled();

    await sm.shutdown();
  });

  it("manual suspend during retry backoff cancels the retry and leaves work for recovery", async () => {
    vi.useFakeTimers();
    try {
      const failing: AgentHandler = {
        start: vi.fn().mockRejectedValue(new FakeRateLimit("rate limited")),
        resume: vi.fn(),
        inject: vi.fn(),
        suspend: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const recovered: AgentHandler = {
        start: vi.fn().mockResolvedValue("session-after-retry"),
        resume: vi.fn().mockResolvedValue("session-after-retry"),
        inject: vi.fn(),
        suspend: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
      const sm = makeManager({ handlers: [failing, recovered], recoverChat });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-suspend-retry", messageId: "msg-retry-1" }));
      await sm.handleCommand("chat-suspend-retry", "session:suspend");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(recovered.start).not.toHaveBeenCalled();
      expect(recoverChat).not.toHaveBeenCalled();

      await sm.dispatch(mockEntry({ id: 2, chatId: "chat-suspend-retry", messageId: "msg-retry-2" }));
      expect(recoverChat).toHaveBeenCalledWith("chat-suspend-retry");
      expect(recovered.start).not.toHaveBeenCalled();

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues newer retry-window messages behind the original unconsumed prefix", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const capturedCtx: SessionContext[] = [];
    const startedMessages: SessionMessage[] = [];
    const injected: SessionMessage[] = [];
    const failing: AgentHandler = {
      start: vi.fn().mockRejectedValue(new FakeRateLimit("rate limited")),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const recovered: AgentHandler = {
      start: vi.fn(async (message, ctx) => {
        startedMessages.push(message);
        capturedCtx.push(ctx);
        return "session-after-retry";
      }),
      resume: vi.fn().mockResolvedValue("session-after-retry"),
      inject: vi.fn((message) => {
        injected.push(message);
        return { kind: "owned", mode: "queued" } as const;
      }),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const sm = makeManager({ handlers: [failing, recovered], ackEntry, recoverChat });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-prefix", messageId: "msg-1" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-prefix", messageId: "msg-2" }));
    await vi.waitFor(() => expect(recovered.start).toHaveBeenCalledTimes(1));

    expect(startedMessages[0]?.id).toBe("msg-1");
    expect(injected.map((message) => message.id)).toEqual(["msg-2"]);

    await capturedCtx[0]?.finishTurn(startedMessages[0] as SessionMessage, { status: "success", terminal: true });
    await capturedCtx[0]?.finishTurn(injected[0] as SessionMessage, { status: "success", terminal: true });

    expect(ackEntry).toHaveBeenNthCalledWith(1, 1);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 2);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("retries the message that failed resume and drains newer work behind it", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    let initialCtx: SessionContext | undefined;
    let initialMessage: SessionMessage | undefined;
    let retryCtx: SessionContext | undefined;
    let retryMessage: SessionMessage | undefined;
    const injected: SessionMessage[] = [];
    const established: AgentHandler = {
      start: vi.fn(async (message, ctx) => {
        initialMessage = message;
        initialCtx = ctx;
        return "established-session";
      }),
      resume: vi.fn().mockRejectedValue(new FakeRateLimit("resume transport failed")),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const recovered: AgentHandler = {
      start: vi.fn(),
      resume: vi.fn(async (message, _sessionId, ctx) => {
        retryMessage = message;
        retryCtx = ctx;
        return "resumed-session";
      }),
      inject: vi.fn((message) => {
        injected.push(message);
        return { kind: "owned", mode: "queued" } as const;
      }),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const sm = makeManager({ handlers: [established, recovered], ackEntry, recoverChat });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-resume-head", messageId: "msg-1" }));
    if (!initialCtx || !initialMessage) throw new Error("initial session was not captured");
    await initialCtx.finishTurn(initialMessage, { status: "success", terminal: true });
    await sm.handleCommand("chat-resume-head", "session:suspend");

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-resume-head", messageId: "msg-2" }));
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-resume-head", messageId: "msg-3" }));
    await vi.waitFor(() => expect(recovered.resume).toHaveBeenCalledTimes(1));

    expect(retryMessage?.id).toBe("msg-2");
    expect(retryMessage?.inboxEntryId).toBe(2);
    expect(retryMessage?.id).not.toBe("msg-1");
    expect(injected.map((message) => message.id)).toEqual(["msg-3"]);
    if (!retryCtx || !retryMessage || !injected[0]) throw new Error("retry routing was not captured");

    await retryCtx.finishTurn(retryMessage, { status: "success", terminal: true });
    await retryCtx.finishTurn(injected[0], { status: "success", terminal: true });

    expect(ackEntry).toHaveBeenNthCalledWith(1, 1);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 2);
    expect(ackEntry).toHaveBeenNthCalledWith(3, 3);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(sm.activeCount).toBe(1);

    await sm.shutdown();
  });

  it("moves a tail that arrives during a pending resume onto the retry handler", async () => {
    vi.useFakeTimers();
    try {
      const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
      let initialCtx: SessionContext | undefined;
      let initialMessage: SessionMessage | undefined;
      let retryCtx: SessionContext | undefined;
      let retryMessage: SessionMessage | undefined;
      let rejectResume: ((reason?: unknown) => void) | undefined;
      let signalResumeStarted: (() => void) | undefined;
      const resumeStarted = new Promise<void>((resolve) => {
        signalResumeStarted = resolve;
      });
      const pendingResume = new Promise<string>((_resolve, reject) => {
        rejectResume = reject;
      });
      const injected: SessionMessage[] = [];
      const established: AgentHandler = {
        start: vi.fn(async (message, ctx) => {
          initialMessage = message;
          initialCtx = ctx;
          return "deferred-resume-session";
        }),
        resume: vi.fn(() => {
          signalResumeStarted?.();
          return pendingResume;
        }),
        inject: vi.fn(),
        suspend: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const recovered: AgentHandler = {
        start: vi.fn(),
        resume: vi.fn(async (message, _sessionId, ctx) => {
          retryMessage = message;
          retryCtx = ctx;
          return "deferred-resume-recovered";
        }),
        inject: vi.fn((message) => {
          injected.push(message);
          return { kind: "owned", mode: "queued" } as const;
        }),
        suspend: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const sm = makeManager({ handlers: [established, recovered], ackEntry });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-pending-resume", messageId: "msg-1" }));
      if (!initialCtx || !initialMessage) throw new Error("initial deferred session was not captured");
      await initialCtx.finishTurn(initialMessage, { status: "success", terminal: true });
      await sm.handleCommand("chat-pending-resume", "session:suspend");

      const headDispatch = sm.dispatch(mockEntry({ id: 2, chatId: "chat-pending-resume", messageId: "msg-2" }));
      await resumeStarted;
      await sm.dispatch(mockEntry({ id: 3, chatId: "chat-pending-resume", messageId: "msg-3" }));
      expect(established.inject).not.toHaveBeenCalled();

      rejectResume?.(new FakeRateLimit("deferred resume transport failed"));
      await headDispatch;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(recovered.resume).toHaveBeenCalledTimes(1);
      expect(retryMessage?.id).toBe("msg-2");
      expect(injected.map((message) => message.id)).toEqual(["msg-3"]);
      if (!retryCtx || !retryMessage || !injected[0]) throw new Error("deferred retry routing was not captured");

      await retryCtx.finishTurn(retryMessage, { status: "success", terminal: true });
      await retryCtx.finishTurn(injected[0], { status: "success", terminal: true });

      expect(ackEntry).toHaveBeenNthCalledWith(1, 1);
      expect(ackEntry).toHaveBeenNthCalledWith(2, 2);
      expect(ackEntry).toHaveBeenNthCalledWith(3, 3);

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a control resume without replaying the previous user message", async () => {
    vi.useFakeTimers();
    try {
      let initialCtx: SessionContext | undefined;
      let initialMessage: SessionMessage | undefined;
      const established: AgentHandler = {
        start: vi.fn(async (message, ctx) => {
          initialMessage = message;
          initialCtx = ctx;
          return "control-session";
        }),
        resume: vi.fn().mockRejectedValue(new FakeRateLimit("control resume transport failed")),
        inject: vi.fn(),
        suspend: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const recovered: AgentHandler = {
        start: vi.fn(),
        resume: vi.fn().mockResolvedValue("control-session-resumed"),
        inject: vi.fn(),
        suspend: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const sm = makeManager({ handlers: [established, recovered] });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-control-retry", messageId: "old-user-message" }));
      if (!initialCtx || !initialMessage) throw new Error("initial control session was not captured");
      await initialCtx.finishTurn(initialMessage, { status: "success", terminal: true });
      await sm.handleCommand("chat-control-retry", "session:suspend");
      await sm.handleCommand("chat-control-retry", "session:resume");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(recovered.resume).toHaveBeenCalledWith(undefined, "control-session", expect.anything());
      expect(recovered.start).not.toHaveBeenCalled();

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
