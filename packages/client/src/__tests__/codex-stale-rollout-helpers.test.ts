import { describe, expect, it } from "vitest";
import {
  CodexStaleRolloutError,
  extractCodexStaleRolloutThreadId,
  isCodexStaleRolloutError,
  staleRolloutRecoveryMessage,
} from "../handlers/codex/stale-rollout.js";

const THREAD_ID = "019f2943-c0af-75b0-9d7b-d58679594749";

describe("codex stale rollout helpers", () => {
  it("detects stale rollout text from string errors", () => {
    expect(isCodexStaleRolloutError(`thread/resume failed: no rollout found for thread id ${THREAD_ID}`)).toBe(true);
    expect(extractCodexStaleRolloutThreadId(`thread/resume failed: no rollout found for thread id ${THREAD_ID}`)).toBe(
      THREAD_ID,
    );
  });

  it("includes Error code, reason, and nested cause text when extracting ids", () => {
    const cause = Object.assign(new Error("outer failure"), {
      cause: `thread/resume failed: no rollout found for thread id ${THREAD_ID}`,
      code: "E_ROLLOUT",
      reason: "missing local rollout",
    });

    expect(extractCodexStaleRolloutThreadId(cause)).toBe(THREAD_ID);
    expect(isCodexStaleRolloutError(cause)).toBe(true);
  });

  it("falls back to the explicit thread id for non-string causes", () => {
    const err = new CodexStaleRolloutError({ reason: "missing" }, THREAD_ID);

    expect(err.threadId).toBe(THREAD_ID);
    expect(err.message).toContain(THREAD_ID);
    expect(isCodexStaleRolloutError(err)).toBe(true);
  });

  it("handles circular object causes without throwing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const err = new CodexStaleRolloutError(circular);

    expect(err.threadId).toBeNull();
    expect(err.message).toContain("[object Object]");
  });

  it("formats recovery messages with and without replacement ids", () => {
    expect(staleRolloutRecoveryMessage(null)).toBe("codex local rollout missing; starting fresh thread");
    expect(staleRolloutRecoveryMessage(THREAD_ID, "fresh-thread")).toBe(
      `codex local rollout missing for stale thread ${THREAD_ID}; starting fresh thread; replacement thread fresh-thread`,
    );
  });
});
