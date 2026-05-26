import { describe, expect, it } from "vitest";
import { detectStreamApiError } from "../handlers/claude-code.js";

/**
 * Task 8 (Bug 6): the `detectStreamApiError` sniffer recognises Claude SDK
 * "API Error: ..." text that was forwarded as a result.success payload, so
 * the runtime can route it through transient retry / structured error
 * events instead of forwarding it as a model reply.
 *
 * The heuristic is intentionally conservative: prefix + length cap +
 * technical hint. Test coverage includes the "user discusses API Error in
 * chat" reverse — that should NOT be flagged.
 */
describe("detectStreamApiError", () => {
  it("flags the canonical socket-closed payload", () => {
    const r = detectStreamApiError(
      "API Error: The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()",
    );
    expect(r).not.toBeNull();
    expect(r?.message).toMatch(/socket connection/);
  });

  it("flags 401 Unauthorized", () => {
    const r = detectStreamApiError("API Error: 401 Unauthorized");
    expect(r).not.toBeNull();
  });

  it("flags Claude API rate-limit one-liner", () => {
    const r = detectStreamApiError("Claude API error: 429 rate limit exceeded");
    expect(r).not.toBeNull();
  });

  it("flags fetch-failed one-liner", () => {
    const r = detectStreamApiError("API Error: fetch failed");
    expect(r).not.toBeNull();
  });

  // NEGATIVE cases — user chat that discusses these strings must NOT flag.
  it("does NOT flag a tutorial-style long answer that mentions API Error", () => {
    const longText = `Sure, let me explain how to handle API Error responses in Claude.

When you call the Anthropic API, sometimes you'll see an "API Error:" prefix
followed by a status code. Here's how to handle each one in your code: 401
means Unauthorized, 429 means rate-limited, 500-class codes are server errors.

You should also be aware that the socket connection can be closed by the
server during long-running requests. Always wrap your fetch() calls in a
try/catch and use exponential backoff for retries. ECONNRESET and ETIMEDOUT
are the usual transient codes.

Hope that helps!`.trim();
    const r = detectStreamApiError(longText);
    expect(r).toBeNull();
  });

  it("does NOT flag a short tutorial line without a technical hint", () => {
    // Has the prefix and short enough, but no socket / fetch / status code
    // hint — almost certainly a benign mention.
    const r = detectStreamApiError("API Error: here's how to handle them");
    expect(r).toBeNull();
  });

  it("does NOT flag a regular model reply that mentions 'API Error' mid-text", () => {
    const r = detectStreamApiError(
      "The endpoint can sometimes return an API Error with a 5xx code. You should retry on those.",
    );
    expect(r).toBeNull(); // wrong prefix — text doesn't start with "API Error:"
  });

  it("does NOT flag the empty string", () => {
    expect(detectStreamApiError("")).toBeNull();
    expect(detectStreamApiError("   ")).toBeNull();
  });

  it("does NOT flag a non-string", () => {
    expect(detectStreamApiError(undefined as unknown as string)).toBeNull();
    expect(detectStreamApiError(null as unknown as string)).toBeNull();
    expect(detectStreamApiError(42 as unknown as string)).toBeNull();
  });

  it("trims and returns only the first line", () => {
    const r = detectStreamApiError("API Error: ETIMEDOUT\nmore lines that should not affect the message");
    expect(r).not.toBeNull();
    expect(r?.message).toBe("API Error: ETIMEDOUT");
  });
});
