import { describe, expect, it } from "vitest";
import { formatAuthHint, isClaudeAuthError, isCodexAuthError } from "../handlers/auth-error-hint.js";

/**
 * Locks the behavioural contract of the auth-error hint module that
 * the codex and claude-code handlers both consume.
 *
 * `isCodexAuthError` must match every canonical wording the bundled
 * `@openai/codex` Rust binary emits when its refresh flow fails — the SDK
 * gives us no typed code, so substring matching is all we have. Drift in
 * either direction is bad: false positives mistranslate unrelated errors
 * into a "run codex login" hint; false negatives let a stale `auth.json`
 * surface as an opaque "ERROR - SDK" line that new users read as "First
 * Tree is broken."
 *
 * `isClaudeAuthError` is a thin equality check against the SDK's typed
 * `SDKAssistantMessageError` union and exists mainly so the codex and
 * claude-code handlers share a single source of truth for the auth-failure code.
 */
describe("isCodexAuthError", () => {
  it("matches every refresh-flow wording extracted from @openai/codex 0.125.0", () => {
    const authMessages = [
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "Your access token could not be refreshed. Please log out and sign in again.",
      "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
      "Token data is not available.",
    ];
    for (const msg of authMessages) {
      expect(isCodexAuthError(msg), `expected auth-error: ${msg}`).toBe(true);
    }
  });

  it("matches when the wording is wrapped in a longer SDK error envelope", () => {
    // ThreadError messages can be wrapped by upstream layers; the keyword
    // detector must still trigger on substring presence.
    expect(
      isCodexAuthError(
        "codex exec failed: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      ),
    ).toBe(true);
  });

  it("does NOT match unrelated SDK errors", () => {
    const nonAuth = [
      "HTTP 500 Internal Server Error",
      "fetch failed",
      "ECONNRESET while reading response",
      "request timed out",
      "sandbox denied write to /etc/passwd",
      "context length exceeded",
      "The server is overloaded",
      "rate limit exceeded",
      "",
    ];
    for (const msg of nonAuth) {
      expect(isCodexAuthError(msg), `expected NOT auth-error: ${msg}`).toBe(false);
    }
  });

  it("returns false for the empty string", () => {
    expect(isCodexAuthError("")).toBe(false);
  });
});

describe("isClaudeAuthError", () => {
  it("matches the canonical SDKAssistantMessageError auth code", () => {
    expect(isClaudeAuthError("authentication_failed")).toBe(true);
  });

  it("does NOT match other SDKAssistantMessageError codes", () => {
    const nonAuth = [
      "oauth_org_not_allowed",
      "billing_error",
      "rate_limit",
      "overloaded",
      "invalid_request",
      "model_not_found",
      "server_error",
      "unknown",
      "max_output_tokens",
    ];
    for (const code of nonAuth) {
      expect(isClaudeAuthError(code), `expected NOT auth-error: ${code}`).toBe(false);
    }
  });

  it("returns false for undefined / empty", () => {
    expect(isClaudeAuthError(undefined)).toBe(false);
    expect(isClaudeAuthError("")).toBe(false);
  });
});

describe("formatAuthHint", () => {
  it("targets `codex login` for the codex runtime and quotes the original SDK message", () => {
    const hint = formatAuthHint(
      "codex",
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
    );
    expect(hint).toContain("codex");
    expect(hint).toContain("`codex login`");
    expect(hint).toContain("OpenAI");
    expect(hint).toContain("not First Tree's");
    expect(hint).toContain("refresh token was revoked");
  });

  it("targets `claude login` for the claude-code runtime", () => {
    const hint = formatAuthHint("claude-code", "authentication_failed");
    expect(hint).toContain("claude-code");
    expect(hint).toContain("`claude login`");
    expect(hint).toContain("Anthropic");
    expect(hint).toContain("not First Tree's");
    expect(hint).toContain("authentication_failed");
  });

  it("falls back to a placeholder when the SDK gives no message", () => {
    const hint = formatAuthHint("codex", "");
    expect(hint).toContain("(no message from SDK)");
  });

  it("caps an oversized SDK error envelope so the hint stays readable in the timeline", () => {
    // Codex error envelopes can occasionally include a wrapped stack trace
    // that runs into the tens of KB. The hint should remain bounded.
    const giantMessage = "x".repeat(5000);
    const hint = formatAuthHint("codex", giantMessage);
    expect(hint.length).toBeLessThan(2000);
    expect(hint).toContain("Original SDK error:");
    // The original message we DO include should be capped, not absent.
    expect(hint).toMatch(/x{500,}/);
  });
});
