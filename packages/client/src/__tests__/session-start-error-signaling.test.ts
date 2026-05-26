import type { SessionEvent, SessionState } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/**
 * Pin the F2 contract from
 * docs/workspace-session-branch-collision-fix-design.md §3.3:
 *
 * When `handler.start` or `handler.resume` throws, the SessionManager must
 *   1) emit `session:state=errored` to the server so admin / UI see it,
 *   2) emit a structured `error` session event so the chat timeline renders
 *      the failure with its distinct ErrorRow styling (NOT a plain text
 *      message — that would be indistinguishable from a normal agent reply),
 *   3) recover so the next inbound message for the same chat can start a
 *      fresh session.
 *
 * Historical note: pre-2026-05 this path forwarded a `⚠️ Session ... failed`
 * **text** message via the result-sink. That worked but rendered identical
 * to a normal agent reply in the chat timeline, so users couldn't tell the
 * agent had crashed vs replied "I failed". The forward path was replaced
 * with a `kind: "error"` session event; the web `ErrorRow` component
 * renders these with a red left-border + tinted background + `error · ...`
 * header so the failure is visually distinguishable.
 */

function mockSdk(): {
  sdk: FirstTreeHubSDK;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue({ id: "msg-reply" });
  const listChatParticipants = vi.fn().mockResolvedValue([
    { agentId: "agent-1", role: "member", mode: "full", name: "agent", displayName: "Agent", type: "autonomous_agent" },
    { agentId: "user-1", role: "member", mode: "full", name: "user", displayName: "User", type: "human" },
  ]);
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

function makeSessionManager(opts: {
  handlers: AgentHandler[];
  onStateChange?: (chatId: string, state: SessionState) => void;
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  sdk?: FirstTreeHubSDK;
}) {
  const factory: HandlerFactory = () => {
    const next = opts.handlers.shift();
    if (!next) throw new Error("handler factory exhausted");
    return next;
  };
  return new SessionManager({
    session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    concurrency: 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Test Agent",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    sdk: opts.sdk ?? mockSdk().sdk,
    log: silentLogger(),
    ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    onStateChange: opts.onStateChange,
    onSessionEvent: opts.onSessionEvent,
  });
}

function failingHandler(): AgentHandler {
  return {
    start: vi.fn().mockRejectedValue(new Error("git worktree add failed: branch already in use")),
    resume: vi.fn(),
    inject: vi.fn(),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function workingHandler(sessionId = "session-after-recovery"): AgentHandler {
  return {
    start: vi.fn().mockResolvedValue(sessionId),
    resume: vi.fn().mockResolvedValue(sessionId),
    inject: vi.fn(),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionManager: session-start failure signalling (F2)", () => {
  it("emits onStateChange('errored') when handler.start throws", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = makeSessionManager({
      handlers: [failingHandler()],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-fail" }));

    // `active` reports BEFORE handler.start (per the runtime-truth fix:
    // server-side `setSessionRuntime` is active-gated, so any runtime frame
    // a handler emits during start() needs the active row to exist first).
    // On a start failure the `errored` transition then overrides it. Both
    // notifications go through — the `lastReportedStates` dedupe only
    // suppresses same-state repeats.
    expect(stateChanges).toEqual([
      { chatId: "chat-fail", state: "active" },
      { chatId: "chat-fail", state: "errored" },
    ]);

    await sm.shutdown();
  });

  it("emits a structured error session event (not a plain text message)", async () => {
    const { sdk, sendMessage } = mockSdk();
    const events: Array<{ chatId: string; event: SessionEvent }> = [];
    const sm = makeSessionManager({
      handlers: [failingHandler()],
      sdk,
      onSessionEvent: (chatId, event) => events.push({ chatId, event }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-fail" }));

    // No plain text forward — errors do NOT round-trip through sendMessage
    // anymore; otherwise they'd be indistinguishable from a normal reply.
    expect(sendMessage).not.toHaveBeenCalled();

    const errorEvents = events.filter((e) => e.event.kind === "error");
    expect(errorEvents).toHaveLength(1);
    const errorEvent = errorEvents[0];
    expect(errorEvent?.chatId).toBe("chat-fail");
    expect(errorEvent?.event.kind).toBe("error");
    if (errorEvent?.event.kind === "error") {
      expect(errorEvent.event.payload.source).toBe("runtime");
      expect(errorEvent.event.payload.message).toContain("Session start failed");
      expect(errorEvent.event.payload.message).toContain("git worktree add failed");
    }

    await sm.shutdown();
  });

  it("truncates the error preview to ~800 characters to keep stderr out of the chat", async () => {
    const giant = `boom: ${"x".repeat(2000)}`;
    const handler = workingHandler();
    handler.start = vi.fn().mockRejectedValue(new Error(giant));
    const events: SessionEvent[] = [];
    const sm = makeSessionManager({
      handlers: [handler],
      onSessionEvent: (_chatId, event) => events.push(event),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-huge-err" }));

    const errEvent = events.find((e) => e.kind === "error");
    expect(errEvent).toBeDefined();
    if (errEvent?.kind === "error") {
      // The event message keeps a short prefix ("Session start failed: "),
      // then up to 800 chars of the original message. Prefix + the 800-char
      // cap puts a hard ceiling well under 900.
      expect(errEvent.payload.message.length).toBeLessThan(900);
      expect(errEvent.payload.message).toContain("boom: ");
    }
  });

  it("allows the next inbound message for the same chat to start a fresh session", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const failing = failingHandler();
    const working = workingHandler("session-after-recovery");
    const sm = makeSessionManager({
      handlers: [failing, working],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    // First dispatch: fails. Now reports `active` (pre-start) then `errored`
    // (catch path) per the runtime-truth ordering fix.
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-recover" }));
    expect(stateChanges).toEqual([
      { chatId: "chat-recover", state: "active" },
      { chatId: "chat-recover", state: "errored" },
    ]);

    // Second dispatch: routes as a fresh start (no `existing` entry).
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recover" }));

    // The recovered session emits `active` (notifySessionState dedupes against
    // the last reported state per chat, so going `errored → active` is a real
    // notification, not a no-op).
    expect(stateChanges.at(-1)).toEqual({ chatId: "chat-recover", state: "active" });
    expect(working.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("still cleans up and recovers when onSessionEvent itself throws", async () => {
    // Defensive contract: a broken event sink (e.g. agent-slot reporting on
    // a dropped WebSocket) must not strand the failed session locally. The
    // cleanup that drops the entry from `sessions` runs even when the
    // emit throws, so the next inbound message routes as a fresh start.
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const failing = failingHandler();
    const working = workingHandler("session-after-broken-emit");
    const sm = makeSessionManager({
      handlers: [failing, working],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      onSessionEvent: () => {
        throw new Error("event sink down");
      },
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-emit-throw" }));
    expect(stateChanges).toEqual([
      { chatId: "chat-emit-throw", state: "active" },
      { chatId: "chat-emit-throw", state: "errored" },
    ]);

    // The next dispatch must route through `startNewSession` (no stale entry
    // left behind by the throwing emit) — verified by the fresh handler's
    // `start` being called and the state moving back to active.
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-emit-throw" }));
    expect(working.start).toHaveBeenCalledTimes(1);
    expect(stateChanges.at(-1)).toEqual({ chatId: "chat-emit-throw", state: "active" });

    await sm.shutdown();
  });
});

describe("SessionManager: session-resume failure signalling (F2, resume path)", () => {
  /**
   * Build a manager whose concurrency is 1 so two consecutive dispatches
   * to different chats preempt the first onto the resume path. The handler
   * factory threads a per-chat queue so each test can stage the exact
   * start/resume outcomes it needs.
   */
  function makeSerializedManager(opts: {
    handlerQueue: AgentHandler[];
    onStateChange?: (chatId: string, state: SessionState) => void;
    onSessionEvent?: (chatId: string, event: SessionEvent) => void;
    sdk?: FirstTreeHubSDK;
  }) {
    const queue = [...opts.handlerQueue];
    return new SessionManager({
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 1,
      handlerFactory: () => queue.shift() ?? workingHandler(),
      handlerConfig: { workspaceRoot: "/tmp/test" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Test Agent",
        type: "autonomous_agent",
        delegateMention: null,
        metadata: {},
      },
      sdk: opts.sdk ?? mockSdk().sdk,
      log: silentLogger(),
      ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
      onStateChange: opts.onStateChange,
      onSessionEvent: opts.onSessionEvent,
    });
  }

  it("emits onStateChange('errored') and a structured error event when handler.resume throws", async () => {
    // Stage: handlerA.start() succeeds; chat-B start preempts chat-A to
    // suspended; the third dispatch then hits resume on chat-A which throws.
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const events: Array<{ chatId: string; event: SessionEvent }> = [];
    const { sdk, sendMessage } = mockSdk();
    const handlerA: AgentHandler = {
      start: vi.fn().mockResolvedValue("session-A"),
      resume: vi.fn().mockRejectedValue(new Error("git mirror fetch failed: connection refused")),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const sm = makeSerializedManager({
      handlerQueue: [handlerA, workingHandler("session-B")],
      sdk,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      onSessionEvent: (chatId, event) => events.push({ chatId, event }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-A" })); // start succeeds
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-B" })); // preempts chat-A
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-A" })); // resume → throws

    const chatAStates = stateChanges.filter((c) => c.chatId === "chat-A").map((c) => c.state);
    expect(chatAStates.at(-1)).toBe("errored");

    const resumeErrEvent = events.find(
      (e) =>
        e.chatId === "chat-A" && e.event.kind === "error" && e.event.payload.message.includes("Session resume failed"),
    );
    expect(resumeErrEvent).toBeDefined();
    if (resumeErrEvent?.event.kind === "error") {
      expect(resumeErrEvent.event.payload.source).toBe("runtime");
      expect(resumeErrEvent.event.payload.message).toContain("git mirror fetch failed");
    }

    // sendMessage should NOT carry the error — that's the regression we're
    // guarding against. (It may be called for unrelated bookkeeping, so we
    // only check that no call references the error string.)
    for (const call of sendMessage.mock.calls) {
      const content = (call[1] as { content?: string })?.content ?? "";
      expect(content).not.toContain("Session resume failed");
    }

    expect(handlerA.resume).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("allows the next inbound message for the same chat to start a fresh session after a resume failure", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const handlerA: AgentHandler = {
      start: vi.fn().mockResolvedValue("session-A"),
      resume: vi.fn().mockRejectedValue(new Error("resume blew up")),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const handlerARecovery = workingHandler("session-A-fresh");
    const sm = makeSerializedManager({
      handlerQueue: [handlerA, workingHandler("session-B"), handlerARecovery],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-A" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-B" }));
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-A" })); // resume → errored

    // A fresh inbound for chat-A should route as start (entry was dropped
    // on resume failure — the resume catch tears down the same way the
    // start catch does, so there's no "stuck suspended" entry blocking it).
    await sm.dispatch(mockEntry({ id: 4, chatId: "chat-A" }));
    expect(handlerARecovery.start).toHaveBeenCalledTimes(1);
    expect(stateChanges.filter((c) => c.chatId === "chat-A").at(-1)?.state).toBe("active");

    await sm.shutdown();
  });
});
