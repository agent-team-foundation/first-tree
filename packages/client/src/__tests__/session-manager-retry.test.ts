import type { SessionEvent, SessionState } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler, HandlerFactory } from "../runtime/handler.js";
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
    ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    onStateChange: opts.onStateChange,
    onSessionEvent: opts.onSessionEvent,
  });
}

class FakeRateLimit extends Error {
  override name = "RateLimitError";
  status = 429;
}

describe("SessionManager: transient retry on session start", () => {
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
});
