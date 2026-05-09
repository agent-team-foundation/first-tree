import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllPendingQuestionsForTest,
  pendingQuestionCount,
  registerPendingQuestion,
  rejectPendingForAgent,
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

  it("rejectPendingForAgent rejects only that agent's entries and returns the count", async () => {
    const a1 = registerPendingQuestion({ correlationId: "tu_a1", agentId: "agent_a", chatId: "chat_a" });
    const a2 = registerPendingQuestion({ correlationId: "tu_a2", agentId: "agent_a", chatId: "chat_a" });
    const b1 = registerPendingQuestion({ correlationId: "tu_b1", agentId: "agent_b", chatId: "chat_b" });
    expect(pendingQuestionCount()).toBe(3);

    const dropped = rejectPendingForAgent("agent_a", "Session shutting down.");
    expect(dropped).toBe(2);
    expect(pendingQuestionCount()).toBe(1);

    await expect(a1).resolves.toEqual({ status: "denied", reason: "Session shutting down." });
    await expect(a2).resolves.toEqual({ status: "denied", reason: "Session shutting down." });

    // agent_b's entry stays pending until explicitly resolved.
    const matched = tryResolveQuestionAnswer({ correlationId: "tu_b1", answers: { q: "v" } });
    expect(matched).toBe(true);
    await expect(b1).resolves.toEqual({ status: "answered", answers: { q: "v" } });
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
