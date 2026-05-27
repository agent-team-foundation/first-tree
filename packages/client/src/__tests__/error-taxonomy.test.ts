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

describe("error-taxonomy.classify", () => {
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
