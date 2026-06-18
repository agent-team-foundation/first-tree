import { describe, expect, it } from "vitest";
import { computePerTurnUsageDelta, isTransientCodexErrorMessage } from "../handlers/codex/index.js";

const usage = (input: number, cached: number, output: number, reasoning = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
});

/**
 * Locks the behavioural contract of the pure helpers introduced for codex
 * handler resilience:
 *   - `isTransientCodexErrorMessage` decides whether the `runTurn` retry
 *     loop fires on a given SDK error / `turn.failed` message. A regression
 *     here either burns retry budget on permanent failures (auth, sandbox)
 *     or silently swallows transient ones.
 *
 * The full `runTurn` retry loop needs a mock Codex + Thread + SessionContext,
 * so the targeted regression for that state machine lives in
 * `codex-retry-abort.test.ts`. The classifier path's correctness here rests on:
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

  it("does not false-positive on numeric IDs that contain HTTP status digits (PR #600 review nit #1)", () => {
    // Before the \b word-boundary tightening, naive `includes("500")` /
    // `includes("401")` would match these and burn retry budget on a
    // non-transient failure (or, for the 401 case, silently swallow a real
    // transient by short-circuiting through the auth branch).
    const noise = [
      "request id 5023 failed: unknown",
      "job_id=5001 produced no output",
      "context window 4012 tokens exceeded the limit", // looks like 401 but isn't
      "task 4030450 finished without emitting a result", // looks like 403 but isn't
      "trace 50123 dropped before flush",
      "model gpt-5024 not available", // looks like 502 but isn't
    ];
    for (const m of noise) {
      expect(isTransientCodexErrorMessage(m), `expected non-transient (id-like): ${m}`).toBe(false);
    }
  });

  it("matches HTTP codes even when adjacent to common punctuation (`:`, `,`, `)`)", () => {
    // \b honours non-word punctuation as a boundary, so these realistic
    // wrapped-error shapes still classify correctly.
    expect(isTransientCodexErrorMessage("openai responded: 500 internal server error")).toBe(true);
    expect(isTransientCodexErrorMessage("status 503, retrying")).toBe(true);
    expect(isTransientCodexErrorMessage("HTTP(502) bad gateway")).toBe(true);
    expect(isTransientCodexErrorMessage("upstream returned 401: unauthorized")).toBe(false);
  });
});

describe("computePerTurnUsageDelta", () => {
  it("fresh thread with no baseline returns the cumulative as-is (turn 1)", () => {
    expect(computePerTurnUsageDelta(usage(1000, 200, 50, 30), null, true)).toEqual(usage(1000, 200, 50, 30));
  });

  it("returns a copy, not the same object, on the fresh-thread path", () => {
    const cumulative = usage(1000, 200, 50);
    const out = computePerTurnUsageDelta(cumulative, null, true);
    expect(out).not.toBe(cumulative);
  });

  it("cold resume with no baseline returns null — skip the emit, don't ship the whole thread as one turn", () => {
    expect(computePerTurnUsageDelta(usage(50_000, 48_000, 900), null, false)).toBeNull();
  });

  it("subtracts the previous cumulative to recover the per-turn delta", () => {
    // turn 2 cumulative minus turn 1 cumulative — codex reports running totals.
    const prev = usage(1000, 200, 50, 30);
    const cumulative = usage(3500, 1800, 130, 90);
    expect(computePerTurnUsageDelta(cumulative, prev, false)).toEqual(usage(2500, 1600, 80, 60));
  });

  it("clamps every field at 0 when the cumulative drops (e.g. a compaction reset)", () => {
    // total shrank below the previous baseline — emit a zeroed turn rather
    // than negative tokens; the baseline advance happens in the caller.
    const prev = usage(10_000, 5_000, 800, 400);
    const cumulative = usage(2_000, 1_000, 100, 50);
    expect(computePerTurnUsageDelta(cumulative, prev, false)).toEqual(usage(0, 0, 0, 0));
  });

  it("baseline takes precedence over threadIsFresh once a previous cumulative exists", () => {
    const prev = usage(1000, 200, 50);
    // threadIsFresh=true is irrelevant here — a non-null baseline means we are
    // past turn 1, so still subtract.
    expect(computePerTurnUsageDelta(usage(1500, 400, 70), prev, true)).toEqual(usage(500, 200, 20, 0));
  });
});
