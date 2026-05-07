import { describe, expect, it } from "vitest";
import * as clientService from "../services/client.js";

/**
 * `deriveAuthState` is a pure function that infers whether a client's
 * locally cached refresh token can plausibly still mint access tokens —
 * the Web admin uses the result to render an "AUTH EXPIRED" pill on rows
 * whose offline duration has exceeded the configured refresh-token TTL.
 *
 * No DB column backs this state — keeping the server side column-less is
 * deliberate (no writers, no migrations, no reset-on-register dance). If
 * we ever want admin-driven revocation, we'd add a column back and OR it
 * into this function; until then the matrix below is the entire surface.
 */
describe("client service: deriveAuthState", () => {
  const NOW = Date.now();
  const SAFE_TTL = 60; // seconds — easy mental math against the offsets below

  it("returns 'ok' for connected clients regardless of how stale lastSeenAt is", () => {
    // A connected client necessarily has a fresh refresh token (it just
    // refreshed). The time-based safety net should never override the
    // explicit live-connection signal.
    const result = clientService.deriveAuthState(
      { status: "connected", lastSeenAt: new Date(NOW - 999_999_999) },
      SAFE_TTL,
    );
    expect(result).toBe("ok");
  });

  it("returns 'ok' for disconnected clients when offline duration < refreshTokenExpiry", () => {
    const result = clientService.deriveAuthState(
      { status: "disconnected", lastSeenAt: new Date(NOW - 30_000) },
      SAFE_TTL,
    );
    expect(result).toBe("ok");
  });

  it("derives 'expired' when offline duration exceeds refreshTokenExpiry", () => {
    // This is the time-based fallback that lets the Web UI show a red
    // "Auth expired — Reconnect" pill without needing the client to
    // come back and report its own failure.
    const result = clientService.deriveAuthState(
      { status: "disconnected", lastSeenAt: new Date(NOW - SAFE_TTL * 1000 - 5_000) },
      SAFE_TTL,
    );
    expect(result).toBe("expired");
  });
});
