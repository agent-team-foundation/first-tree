import { describe, expect, it } from "vitest";
import {
  clampRetryAttempt,
  classify,
  ERROR_KINDS,
  nextRetryDelayMs,
  type RetryStrategy,
} from "../runtime/error-taxonomy.js";

class FakeRateLimitError extends Error {
  override name = "RateLimitError";
  status = 429;
}

class FakeServerError extends Error {
  override name = "InternalServerError";
  status = 503;
}

class FakeConnError extends Error {
  override name = "APIConnectionError";
}

class FakeAuthRefreshFailedError extends Error {
  override name = "AuthRefreshFailedError";
}

class FakeAuthRefreshRateLimitedError extends Error {
  override name = "AuthRefreshRateLimitedError";
}

class FakeClientUserMismatchError extends Error {
  override name = "ClientUserMismatchError";
}

function noMessageShape(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...fields,
    toJSON: () => undefined,
  };
}

describe("error-taxonomy.classify", () => {
  describe("shape normalization edge cases", () => {
    it("reads optional fields from Error instances", () => {
      const err = Object.assign(new Error("status code only"), {
        statusCode: 429,
        reason: "not_owned",
        cause: new Error("root cause"),
      });

      expect(classify(err).reasonCode).toBe("claude_rate_limit");
      expect(classify(err, { source: "bind" }).reasonCode).toBe("bind_not_owned");
    });

    it("handles object shapes whose JSON representation is undefined", () => {
      const c = classify(noMessageShape());
      expect(c.reasonCode).toBe("unknown");
      expect(c.message).toBe("Unknown error");
    });
  });

  describe("Claude SDK errors (default source)", () => {
    it("RateLimitError → transient (claude_rate_limit)", () => {
      const c = classify(new FakeRateLimitError("you are rate limited"));
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("claude_rate_limit");
      expect(c.strategy.kind).toBe("exponentialBackoff");
    });

    it("HTTP 5xx → transient (claude_server_error)", () => {
      const c = classify(new FakeServerError("overloaded"));
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("claude_server_error");
    });

    it("socket-closed message → transient (claude_socket_closed)", () => {
      const c = classify(new Error("The socket connection was closed unexpectedly"));
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("claude_socket_closed");
    });

    it("APIConnectionError → transient (claude_socket_closed)", () => {
      const c = classify(new FakeConnError("connection error"));
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("claude_socket_closed");
    });

    it("ECONNRESET code → transient (network_error)", () => {
      const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const c = classify(err);
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("network_error");
    });

    it("ClientUserMismatchError → permanent", () => {
      const c = classify(new FakeClientUserMismatchError("wrong user"));
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("client_identity_mismatch");
      expect(c.strategy.kind).toBe("none");
    });

    it("AuthRefreshFailedError without source → permanent", () => {
      const c = classify(new FakeAuthRefreshFailedError("refresh died"));
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("auth_refresh_failed");
    });

    it("ClaudeTuiLoginRequiredError (session source) → permanent, no retry", () => {
      const err = new Error("claude TUI requires re-authentication (run /login) — session=ftth-x");
      err.name = "ClaudeTuiLoginRequiredError";
      const c = classify(err, { source: "session" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("claude_login_required");
      expect(c.strategy.kind).toBe("none");
    });

    it("ClientOrgMismatchError → permanent with default message", () => {
      const c = classify(noMessageShape({ name: "ClientOrgMismatchError" }));
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("client_identity_mismatch");
      expect(c.message).toBe("Client identity mismatch");
    });

    it("AuthRefreshFailedError without message uses default refresh message", () => {
      const c = classify(noMessageShape({ name: "AuthRefreshFailedError" }));
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("auth_refresh_failed");
      expect(c.message).toBe("Refresh token rejected");
    });

    it("Codex missing binary errors are permanent", () => {
      for (const message of [
        "Unable to locate Codex CLI binaries for x86_64-apple-darwin. Ensure @openai/codex is installed with optional dependencies.",
        "Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest",
      ]) {
        const c = classify(new Error(message), { source: "session" });
        expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
        expect(c.reasonCode).toBe("codex_binary_missing");
        expect(c.strategy.kind).toBe("none");
      }
      const stackOnly = new Error("codex startup failed");
      stackOnly.stack = "Error: codex startup failed\n    at findCodexPath (index.js:445:11)";
      const stackClass = classify(stackOnly, { source: "session" });
      expect(stackClass.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(stackClass.reasonCode).toBe("codex_binary_missing");
      expect(stackClass.strategy.kind).toBe("none");
    });

    it("a transient codex --version verify flake is transient, not a missing binary", () => {
      const err = new Error("codex --version smoke check did not complete (transient host condition); will retry.");
      err.name = "CodexBinaryVerifyTransientError";
      const c = classify(err, { source: "session" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("codex_verify_transient");
      expect(c.strategy.kind).toBe("exponentialBackoff");
    });

    it("AbortSignal.timeout TimeoutError is transient (recognised by name and by message)", () => {
      const byName = classify(new DOMException("The operation was aborted due to timeout", "TimeoutError"), {
        source: "session",
      });
      expect(byName.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(byName.reasonCode).toBe("operation_timeout");
      // Proxied/wrapped errors that lose the DOMException name still match on text.
      const byText = classify(new Error("The operation was aborted due to timeout"));
      expect(byText.reasonCode).toBe("operation_timeout");
      expect(byText.kind).toBe(ERROR_KINDS.TRANSIENT);
    });

    it("status-only and text-only Claude errors cover non-name branches and defaults", () => {
      expect(classify(noMessageShape({ status: 429 })).message).toBe("Claude API rate limit");
      expect(classify("rate limit exceeded").reasonCode).toBe("claude_rate_limit");
      expect(classify(noMessageShape({ status: 503 })).message).toBe("Claude API server error");
      expect(classify("upstream server error").reasonCode).toBe("claude_server_error");
    });

    it("socket and network fallbacks cover fetch, missing-message, and default-message branches", () => {
      expect(classify(new Error("fetch failed")).reasonCode).toBe("claude_socket_closed");
      expect(classify(noMessageShape({ name: "APIConnectionError" })).message).toBe("Claude API connection dropped");
      expect(classify(noMessageShape({ code: "ECONNRESET" })).message).toBe("Network error");
    });
  });

  describe("source=auth", () => {
    it("AuthRefreshFailedError → permanent (auth_rejected)", () => {
      const c = classify(new FakeAuthRefreshFailedError("token revoked"), { source: "auth" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("auth_rejected");
    });

    it("AuthRefreshRateLimitedError → transient", () => {
      const c = classify(new FakeAuthRefreshRateLimitedError("rate limited"), { source: "auth" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("auth_rate_limited");
    });

    it("expired token message → transient (auth_expired)", () => {
      const c = classify(new Error("access token expired"), { source: "auth" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("auth_expired");
    });

    it("network refresh failures → transient (auth_network_error)", () => {
      const c = classify({ message: "connect ECONNRESET", code: "ECONNRESET" }, { source: "auth" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("auth_network_error");
    });

    it("matches auth rejection and rate limit by message text", () => {
      expect(classify("auth:rejected", { source: "auth" }).reasonCode).toBe("auth_rejected");
      expect(classify("hit a rate limit", { source: "auth" }).reasonCode).toBe("auth_rate_limited");
    });

    it("uses default auth messages when classified shapes have no message", () => {
      expect(classify(noMessageShape({ name: "AuthRefreshFailedError" }), { source: "auth" }).message).toBe(
        "Auth rejected by server",
      );
      expect(classify(noMessageShape({ name: "AuthRefreshRateLimitedError" }), { source: "auth" }).message).toBe(
        "Auth refresh rate limited",
      );
      expect(classify(noMessageShape({ name: "AuthExpiredError" }), { source: "auth" }).message).toBe(
        "Auth token expired",
      );
      expect(classify(noMessageShape({ code: "ECONNRESET" }), { source: "auth" }).message).toBe("Auth network error");
    });
  });

  describe("source=bind", () => {
    it("wrong_client → transient", () => {
      const c = classify({ reason: "wrong_client" }, { source: "bind" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("bind_wrong_client");
    });

    it("agent_suspended → degraded", () => {
      const c = classify({ reason: "agent_suspended" }, { source: "bind" });
      expect(c.kind).toBe(ERROR_KINDS.DEGRADED);
      expect(c.reasonCode).toBe("bind_agent_suspended");
      expect(c.strategy.kind).toBe("none");
    });

    it("wrong_org → degraded", () => {
      const c = classify({ reason: "wrong_org" }, { source: "bind" });
      expect(c.kind).toBe(ERROR_KINDS.DEGRADED);
      expect(c.reasonCode).toBe("bind_wrong_org");
    });

    it("unknown_agent → degraded", () => {
      const c = classify({ reason: "unknown_agent" }, { source: "bind" });
      expect(c.kind).toBe(ERROR_KINDS.DEGRADED);
    });

    it("runtime_provider_mismatch → degraded", () => {
      const c = classify({ reason: "runtime_provider_mismatch" }, { source: "bind" });
      expect(c.kind).toBe(ERROR_KINDS.DEGRADED);
    });

    it("unknown reason → transient (bind_unknown)", () => {
      const c = classify({ reason: "weird_thing" }, { source: "bind" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("bind_unknown");
    });

    it("falls back to the error message or unknown for missing bind reasons", () => {
      expect(classify({ message: "not_owned" }, { source: "bind" }).reasonCode).toBe("bind_not_owned");
      expect(classify("", { source: "bind" }).message).toBe("bind rejected: unknown");
      expect(classify(noMessageShape(), { source: "bind" }).message).toBe("bind rejected: unknown");
    });
  });

  describe("source=update (npm install)", () => {
    it("EBADENGINE → permanent", () => {
      const err = Object.assign(new Error("Unsupported engine"), { code: "EBADENGINE" });
      const c = classify(err, { source: "update" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("npm_ebadengine");
    });

    it("EACCES → permanent", () => {
      const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const c = classify(err, { source: "update" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("npm_permission_denied");
    });

    it("404 not found → permanent", () => {
      const c = classify(new Error("npm ERR! 404 Not Found - GET https://registry.npmjs.org/foo"), {
        source: "update",
      });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("npm_version_not_found");
    });

    it("ENOTFOUND → transient", () => {
      const err = Object.assign(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"), { code: "ENOTFOUND" });
      const c = classify(err, { source: "update" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("npm_network_error");
    });

    it("unrecognised npm err → transient (npm_unknown)", () => {
      const c = classify(new Error("npm install exited with code 42"), { source: "update" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("npm_unknown");
    });

    it("uses code-only update classifications and default messages", () => {
      expect(classify(noMessageShape({ code: "EBADENGINE" }), { source: "update" }).message).toBe(
        "Node engine mismatch",
      );
      expect(classify(noMessageShape({ code: "EACCES" }), { source: "update" }).message).toBe(
        "npm install permission denied",
      );
      expect(classify(noMessageShape({ code: "ENOVERSIONS" }), { source: "update" }).message).toBe(
        "npm package version not found",
      );
      expect(classify(noMessageShape({ code: "ECONNRESET" }), { source: "update" }).message).toBe(
        "npm install network error",
      );
      expect(classify(noMessageShape(), { source: "update" }).message).toBe("npm install failed");
    });
  });

  describe("source=stream", () => {
    it("API Error: socket closed text → transient", () => {
      const c = classify(new Error("API Error: The socket connection was closed unexpectedly"), {
        source: "stream",
      });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("claude_socket_closed");
    });

    it("API Error: 401 unauthorized → permanent", () => {
      const c = classify(new Error("API Error: 401 Unauthorized"), { source: "stream" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("claude_unauthorized");
    });

    it("API Error without auth status → transient stream error", () => {
      const c = classify(new Error("API Error: upstream reset"), { source: "stream" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("claude_socket_closed");
    });

    it("stream source with no message falls through to the generic unknown bucket", () => {
      const c = classify(noMessageShape(), { source: "stream" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("unknown");
    });
  });

  describe("fallback", () => {
    it("unknown error → transient (unknown)", () => {
      const c = classify(new Error("something I have never seen before"));
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.reasonCode).toBe("unknown");
      expect(c.strategy.kind).toBe("exponentialBackoff");
    });

    it("non-Error thrown values are normalised", () => {
      expect(classify("plain string").kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(classify(42).kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(classify(null).kind).toBe(ERROR_KINDS.TRANSIENT);
    });

    it("normalises object-shaped thrown values with non-string fields", () => {
      const c = classify({ name: 123, message: { nested: true }, code: 500, statusCode: 429, reason: 42 });
      expect(c.reasonCode).toBe("claude_rate_limit");
      expect(c.message).toContain('"nested":true');
    });
  });

  describe("source=config", () => {
    // The agent row and its config row are created in the same DB transaction
    // (server `agent.ts` create path), so a 4xx from `/agent/config` is a
    // deterministic, non-self-healing condition — never a bring-up race.
    const cfg = (statusCode: number, message = "config error") => Object.assign(new Error(message), { statusCode });

    it("401 → permanent (auth rejected, won't self-heal)", () => {
      const c = classify(cfg(401), { source: "config" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.strategy.kind).toBe("none");
      expect(c.reasonCode).toBe("config_unauthorized");
    });

    it("403 → permanent (forbidden)", () => {
      const c = classify(cfg(403), { source: "config" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("config_unauthorized");
    });

    it("404 → permanent (agent/config row is gone, not a race)", () => {
      const c = classify(cfg(404), { source: "config" });
      expect(c.kind).toBe(ERROR_KINDS.PERMANENT);
      expect(c.reasonCode).toBe("config_rejected");
    });

    it("400 → permanent (deterministic bad request)", () => {
      expect(classify(cfg(400), { source: "config" }).kind).toBe(ERROR_KINDS.PERMANENT);
    });

    it("503 → transient with exponential backoff", () => {
      const c = classify(cfg(503), { source: "config" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(c.strategy.kind).toBe("exponentialBackoff");
    });

    it("429 → transient (rate limited)", () => {
      expect(classify(cfg(429), { source: "config" }).kind).toBe(ERROR_KINDS.TRANSIENT);
    });

    it("408 → transient (request timeout)", () => {
      expect(classify(cfg(408), { source: "config" }).kind).toBe(ERROR_KINDS.TRANSIENT);
    });

    it("network failure → transient", () => {
      const c = classify(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }), { source: "config" });
      expect(c.kind).toBe(ERROR_KINDS.TRANSIENT);
    });

    it("unknown non-HTTP failure → transient (conservative)", () => {
      expect(classify(new Error("weird"), { source: "config" }).kind).toBe(ERROR_KINDS.TRANSIENT);
      expect(classify("oops", { source: "config" }).kind).toBe(ERROR_KINDS.TRANSIENT);
    });
  });
});

describe("error-taxonomy.nextRetryDelayMs", () => {
  it("returns 0 for strategy.none", () => {
    expect(nextRetryDelayMs({ kind: "none" }, 1)).toBe(0);
  });

  it("doubles per attempt and clamps at cap", () => {
    const s: RetryStrategy = { kind: "exponentialBackoff", baseMs: 1_000, capMs: 10_000, jitter: false };
    expect(nextRetryDelayMs(s, 1)).toBe(1_000);
    expect(nextRetryDelayMs(s, 2)).toBe(2_000);
    expect(nextRetryDelayMs(s, 3)).toBe(4_000);
    expect(nextRetryDelayMs(s, 4)).toBe(8_000);
    expect(nextRetryDelayMs(s, 5)).toBe(10_000);
    expect(nextRetryDelayMs(s, 20)).toBe(10_000);
  });

  it("jitter stays within ±20% of base", () => {
    const s: RetryStrategy = { kind: "exponentialBackoff", baseMs: 1_000, capMs: 60_000, jitter: true };
    for (let i = 0; i < 50; i++) {
      const v = nextRetryDelayMs(s, 1);
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it("clampRetryAttempt floors at 1 and caps at 30", () => {
    expect(clampRetryAttempt(0)).toBe(1);
    expect(clampRetryAttempt(-5)).toBe(1);
    expect(clampRetryAttempt(40)).toBe(30);
    expect(clampRetryAttempt(7.6)).toBe(7);
  });
});
