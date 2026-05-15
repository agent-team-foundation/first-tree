import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllPendingQuestionsForTest,
  clearPendingForChat,
  hasPendingForChat,
  pendingQuestionCount,
  registerPendingQuestion,
  rejectPendingForChat,
  tryResolveQuestionAnswer,
} from "../handlers/ask-user-bridge.js";

afterEach(() => {
  clearAllPendingQuestionsForTest();
});

describe("ask-user-bridge", () => {
  it("registerPendingQuestion → tryResolveQuestionAnswer happy path", async () => {
    const promise = registerPendingQuestion({
      correlationId: "tu_1",
      agentId: "agent_a",
      chatId: "chat_a",
    });
    expect(pendingQuestionCount()).toBe(1);

    const matched = tryResolveQuestionAnswer({
      correlationId: "tu_1",
      answers: { "Should I proceed?": "Yes" },
    });
    expect(matched).toBe(true);
    expect(pendingQuestionCount()).toBe(0);

    const result = await promise;
    expect(result).toEqual({
      status: "answered",
      answers: { "Should I proceed?": "Yes" },
    });
  });

  it("tryResolveQuestionAnswer returns false when no matching pending entry exists", () => {
    const matched = tryResolveQuestionAnswer({
      correlationId: "tu_unknown",
      answers: { foo: "bar" },
    });
    expect(matched).toBe(false);
  });

  it("tryResolveQuestionAnswer returns false on a malformed payload", async () => {
    // Register so the bridge has *some* state — confirms the malformed answer
    // doesn't accidentally match anything.
    void registerPendingQuestion({ correlationId: "tu_a", agentId: "agent_a", chatId: "chat_a" });

    expect(tryResolveQuestionAnswer({ correlationId: "tu_a" })).toBe(false); // missing `answers`
    expect(tryResolveQuestionAnswer({ answers: { q: "a" } })).toBe(false); // missing `correlationId`
    expect(tryResolveQuestionAnswer({ correlationId: "", answers: { q: "a" } })).toBe(false); // empty id
    expect(tryResolveQuestionAnswer(null)).toBe(false);
    expect(tryResolveQuestionAnswer("string")).toBe(false);
  });

  it("rejectPendingForChat rejects only that (agent, chat) handler's entries and returns the count", async () => {
    const a1 = registerPendingQuestion({ correlationId: "tu_a1", agentId: "agent_a", chatId: "chat_a" });
    const a2 = registerPendingQuestion({ correlationId: "tu_a2", agentId: "agent_a", chatId: "chat_a" });
    const b1 = registerPendingQuestion({ correlationId: "tu_b1", agentId: "agent_b", chatId: "chat_b" });
    expect(pendingQuestionCount()).toBe(3);

    const dropped = rejectPendingForChat("agent_a", "chat_a", "Session shutting down.");
    expect(dropped).toBe(2);
    expect(pendingQuestionCount()).toBe(1);

    await expect(a1).resolves.toEqual({ status: "denied", reason: "Session shutting down." });
    await expect(a2).resolves.toEqual({ status: "denied", reason: "Session shutting down." });

    // agent_b's entry stays pending until explicitly resolved.
    const matched = tryResolveQuestionAnswer({ correlationId: "tu_b1", answers: { q: "v" } });
    expect(matched).toBe(true);
    await expect(b1).resolves.toEqual({ status: "answered", answers: { q: "v" } });
  });

  it("rejectPendingForChat does NOT touch other chats of the same agent (#418)", async () => {
    // The regression that motivated this scope key: one chat shutting down
    // used to nuke another chat's pending askuser waiters because the
    // bridge cleanup was per-agent, but handlers (and SDK transports) are
    // per-(agent, chat). With per-chat scoping, tearing down chat_a leaves
    // chat_b's awaiter alive so the user can still answer.
    const a1 = registerPendingQuestion({ correlationId: "tu_a1", agentId: "agent_shared", chatId: "chat_a" });
    const b1 = registerPendingQuestion({ correlationId: "tu_b1", agentId: "agent_shared", chatId: "chat_b" });
    expect(pendingQuestionCount()).toBe(2);

    const dropped = rejectPendingForChat("agent_shared", "chat_a", "Session shutting down.");
    expect(dropped).toBe(1);
    expect(pendingQuestionCount()).toBe(1);

    await expect(a1).resolves.toEqual({ status: "denied", reason: "Session shutting down." });

    // chat_b's awaiter survives the chat_a shutdown.
    expect(hasPendingForChat("agent_shared", "chat_b")).toBe(true);
    const matched = tryResolveQuestionAnswer({ correlationId: "tu_b1", answers: { q: "still alive" } });
    expect(matched).toBe(true);
    await expect(b1).resolves.toEqual({ status: "answered", answers: { q: "still alive" } });
  });

  it("clearPendingForChat silently removes only the matching (agent, chat) entries (#418)", async () => {
    // suspend-path cleanup: removes without resolving (the SDK transport is
    // being torn down). Per-chat scoping prevents one chat's suspend from
    // wiping another chat's still-live waiter on the same agent.
    const a1 = registerPendingQuestion({ correlationId: "tu_a1", agentId: "agent_shared", chatId: "chat_a" });
    const b1 = registerPendingQuestion({ correlationId: "tu_b1", agentId: "agent_shared", chatId: "chat_b" });
    expect(pendingQuestionCount()).toBe(2);

    let a1Settled = false;
    void a1.then(() => {
      a1Settled = true;
    });

    const dropped = clearPendingForChat("agent_shared", "chat_a");
    expect(dropped).toBe(1);
    expect(pendingQuestionCount()).toBe(1);

    // clearPendingForChat does NOT resolve the Promise — it's a silent
    // cleanup. Give the microtask queue a tick to prove the Promise stays
    // pending.
    await Promise.resolve();
    expect(a1Settled).toBe(false);

    // chat_b's awaiter is untouched and still resolves on answer.
    expect(hasPendingForChat("agent_shared", "chat_b")).toBe(true);
    const matched = tryResolveQuestionAnswer({ correlationId: "tu_b1", answers: { q: "ok" } });
    expect(matched).toBe(true);
    await expect(b1).resolves.toEqual({ status: "answered", answers: { q: "ok" } });
  });

  it("hasPendingForChat reports true only for the matching (agent, chat) pair", () => {
    void registerPendingQuestion({ correlationId: "tu_x1", agentId: "agent-a", chatId: "chat-1" });
    void registerPendingQuestion({ correlationId: "tu_x2", agentId: "agent-b", chatId: "chat-1" });

    expect(hasPendingForChat("agent-a", "chat-1")).toBe(true);
    expect(hasPendingForChat("agent-b", "chat-1")).toBe(true);
    expect(hasPendingForChat("agent-a", "chat-2")).toBe(false);
    expect(hasPendingForChat("agent-c", "chat-1")).toBe(false);
  });

  it("re-registering the same correlationId resolves the previous waiter as denied", async () => {
    const first = registerPendingQuestion({
      correlationId: "tu_dup",
      agentId: "agent_a",
      chatId: "chat_a",
    });
    const second = registerPendingQuestion({
      correlationId: "tu_dup",
      agentId: "agent_a",
      chatId: "chat_a",
    });

    await expect(first).resolves.toMatchObject({ status: "denied" });

    // Only the second waiter is left — resolving by correlation id wakes it up.
    expect(pendingQuestionCount()).toBe(1);
    const matched = tryResolveQuestionAnswer({
      correlationId: "tu_dup",
      answers: { q: "yes" },
    });
    expect(matched).toBe(true);
    await expect(second).resolves.toEqual({ status: "answered", answers: { q: "yes" } });
  });
});
