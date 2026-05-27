import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCodexHandlerStateForTests,
  detectAgentsMdConcurrentWrite,
  isTransientCodexErrorMessage,
} from "../handlers/codex.js";

/**
 * Locks the behavioural contract of the two pure helpers introduced for
 * codex handler resilience:
 *   - `isTransientCodexErrorMessage` decides whether the `runTurn` retry
 *     loop fires on a given SDK error / `turn.failed` message. A regression
 *     here either burns retry budget on permanent failures (auth, sandbox)
 *     or silently swallows transient ones.
 *   - `detectAgentsMdConcurrentWrite` surfaces proposal-§⓪.3 race-window
 *     events. It uses module-level state, so the reset hatch must work
 *     between tests — otherwise leaked state from one test contaminates
 *     the next.
 *
 * The full `runTurn` retry loop (mock Codex + Thread + SessionContext) is
 * intentionally NOT covered here — testing it end-to-end requires faking
 * the bootstrap / git-mirror / first-tree integration chain, which would
 * double the PR scope. The retry path's correctness rests on:
 *   1. typecheck (covers `usageBox` narrowing + control flow)
 *   2. `isTransientCodexErrorMessage` table (this file)
 *   3. the existing `codex-bootstrap.test.ts` / `codex-thread-options.test.ts`
 *      coverage of the bootstrap + options paths it touches.
 */

describe("isTransientCodexErrorMessage", () => {
  it("matches HTTP 5xx + canonical transient keywords (the retry-on set)", () => {
    const transient = [
      "HTTP 500 Internal Server Error",
      "Status: 502 Bad Gateway",
      "503 service unavailable",
      "504 Gateway Timeout",
      "rate limit exceeded",
      "rate_limit_exceeded",
      "The server is overloaded",
      "service is currently unavailable",
      "request timed out",
      "client timeout",
      "fetch failed",
      "network connection lost",
      "ECONNRESET while reading response",
      "ECONNREFUSED 127.0.0.1:443",
      "ETIMEDOUT after 30000ms",
      "EPIPE write after end",
    ];
    for (const m of transient) {
      expect(isTransientCodexErrorMessage(m), `expected transient: ${m}`).toBe(true);
    }
  });

  it("does NOT match auth / sandbox / context-length failures (the never-retry set)", () => {
    const permanent = [
      "401 Unauthorized",
      "HTTP 403 Forbidden",
      "request was Unauthorized by the API",
      "Forbidden: missing scope",
      "invalid api key",
      "invalid_api_key",
      "authentication failed",
      "context length exceeded",
      "context_length_exceeded",
      "sandbox denied write to /etc/passwd",
      "approval policy rejected the action",
    ];
    for (const m of permanent) {
      expect(isTransientCodexErrorMessage(m), `expected permanent: ${m}`).toBe(false);
    }
  });

  it("auth keywords short-circuit even when the message also contains a transient one", () => {
    // Real-world tail-of-stacktrace shape: auth failure wrapped in retry-prone
    // wording. We MUST NOT retry — the credentials are bad, not the network.
    expect(isTransientCodexErrorMessage("401 unauthorized after fetch failed")).toBe(false);
    expect(isTransientCodexErrorMessage("503 unavailable but root cause: invalid api key")).toBe(false);
    expect(isTransientCodexErrorMessage("network glitch caused authentication failure")).toBe(false);
  });

  it("is case-insensitive (matches lowercased + uppercased + mixed forms)", () => {
    expect(isTransientCodexErrorMessage("FETCH FAILED")).toBe(true);
    expect(isTransientCodexErrorMessage("Rate Limit hit")).toBe(true);
    expect(isTransientCodexErrorMessage("ETimedOut")).toBe(true);
  });

  it("does not match unrelated / ambiguous messages (no false positives)", () => {
    const ignore = [
      "Codex Exec exited with code 0", // happy path; should never reach the classifier
      "the agent returned a tool with status pending",
      "model is gpt-5-codex",
      "todo_list updated",
      "",
    ];
    for (const m of ignore) {
      expect(isTransientCodexErrorMessage(m), `expected non-transient: ${m}`).toBe(false);
    }
  });
});

describe("detectAgentsMdConcurrentWrite + __resetCodexHandlerStateForTests", () => {
  beforeEach(() => {
    __resetCodexHandlerStateForTests();
  });

  it("does not log on the first write for a workspace (no prior record)", () => {
    const log = vi.fn();
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_000, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("does not log when writes are spaced apart (>= AGENTS_MD_RACE_WINDOW_MS)", () => {
    const log = vi.fn();
    // Race window is 100 ms in the SUT; 150 ms gap is comfortably outside.
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_000, log);
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_150, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs once with workspace + gap_ms when two writes fall inside the race window", () => {
    const log = vi.fn();
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_000, log);
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_050, log);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = log.mock.calls[0]?.[0] as string;
    expect(msg).toContain("workspace=/workspaces/agent-a");
    expect(msg).toContain("gap_ms=50");
    // Reference to the proposal section makes the log greppable in ops.
    expect(msg).toContain("§⓪.3");
  });

  it("tracks per-workspace state — concurrent writes on different agents do not cross-fire", () => {
    const log = vi.fn();
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_000, log);
    detectAgentsMdConcurrentWrite("/workspaces/agent-b", 1_010, log);
    detectAgentsMdConcurrentWrite("/workspaces/agent-c", 1_020, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs on each subsequent write that lands inside the window — not just the first", () => {
    const log = vi.fn();
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_000, log);
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_040, log); // 40ms gap
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_080, log); // 40ms gap from prev
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("__resetCodexHandlerStateForTests clears prior state — first post-reset write logs nothing", () => {
    const log = vi.fn();
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_000, log);
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_010, log);
    expect(log).toHaveBeenCalledTimes(1);

    __resetCodexHandlerStateForTests();
    log.mockClear();

    // After reset, the second write of the new run should not see any
    // record of the pre-reset writes.
    detectAgentsMdConcurrentWrite("/workspaces/agent-a", 1_020, log);
    expect(log).not.toHaveBeenCalled();
  });
});
