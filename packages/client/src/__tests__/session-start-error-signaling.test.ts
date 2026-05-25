import type { SessionState } from "@first-tree/shared";
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
 *   2) forward a user-visible chat message via the result-sink so the chat
 *      doesn't go silent, and
 *   3) recover so the next inbound message for the same chat can start a
 *      fresh session.
 *
 * Pre-fix the catch block only torn local state down — the server still
 * thought the session was `active`, and no chat message surfaced the
 * failure to the user.
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

    expect(stateChanges).toEqual([{ chatId: "chat-fail", state: "errored" }]);

    await sm.shutdown();
  });

  it("forwards a user-visible error message via the result sink", async () => {
    const { sdk, sendMessage } = mockSdk();
    const sm = makeSessionManager({ handlers: [failingHandler()], sdk });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-fail" }));

    // sendMessage gets called once — the forwarded user-visible error.
    // The chat shows `Session start failed (<agent>): <truncated err>`.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = sendMessage.mock.calls[0] ?? [];
    const content = (payload as { content?: string })?.content ?? "";
    expect(content).toContain("Session start failed");
    expect(content).toContain("Test Agent");
    expect(content).toContain("git worktree add failed");

    await sm.shutdown();
  });

  it("truncates the forwarded error to ~800 characters to keep stderr out of the chat", async () => {
    const { sdk, sendMessage } = mockSdk();
    const giant = `boom: ${"x".repeat(2000)}`;
    const handler = workingHandler();
    handler.start = vi.fn().mockRejectedValue(new Error(giant));
    const sm = makeSessionManager({ handlers: [handler], sdk });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-huge-err" }));

    const [, payload] = sendMessage.mock.calls[0] ?? [];
    const content = (payload as { content?: string })?.content ?? "";
    // The forwarded body keeps a short prefix ("Session start failed (…): "),
    // then up to 800 chars of the original message. Headers + prefix put a
    // floor on total length but the bulk of `xxx…` cap is 800.
    expect(content.length).toBeLessThan(900);
    expect(content).toContain("boom: ");
  });

  it("allows the next inbound message for the same chat to start a fresh session", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const failing = failingHandler();
    const working = workingHandler("session-after-recovery");
    const sm = makeSessionManager({
      handlers: [failing, working],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    // First dispatch: fails.
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-recover" }));
    expect(stateChanges).toEqual([{ chatId: "chat-recover", state: "errored" }]);

    // Second dispatch: routes as a fresh start (no `existing` entry).
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recover" }));

    // The recovered session emits `active` (notifySessionState dedupes against
    // the last reported state per chat, so going `errored → active` is a real
    // notification, not a no-op).
    expect(stateChanges.at(-1)).toEqual({ chatId: "chat-recover", state: "active" });
    expect(working.start).toHaveBeenCalledTimes(1);

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
    });
  }

  it("emits onStateChange('errored') and forwards a chat-visible error when handler.resume throws", async () => {
    // Stage: handlerA.start() succeeds; chat-B start preempts chat-A to
    // suspended; the third dispatch then hits resume on chat-A which throws.
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
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
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-A" })); // start succeeds
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-B" })); // preempts chat-A
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-A" })); // resume → throws

    const chatAStates = stateChanges.filter((c) => c.chatId === "chat-A").map((c) => c.state);
    expect(chatAStates.at(-1)).toBe("errored");
    const resumeFwd = sendMessage.mock.calls.find((call) =>
      ((call[1] as { content?: string })?.content ?? "").includes("Session resume failed"),
    );
    expect(resumeFwd).toBeDefined();
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
