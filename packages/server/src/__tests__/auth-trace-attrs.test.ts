import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import type { AppError } from "../errors.js";
import { exchangeConnectToken, refreshAccessToken } from "../services/auth.js";

/**
 * Regression for issue #246. Asserts that `/auth/refresh` and
 * `/auth/connect-token` failure paths attach enough attributes onto the
 * thrown `AppError` for trace backends to identify the originating user
 * and the specific jose failure mode — *without* the catch swallowing
 * `err.code` into a generic bucket or losing the untrusted `sub`.
 *
 * Service-level (not HTTP-level) so we don't pay app boot per assertion;
 * the errorHandler-to-span wiring is covered by the existing app tests.
 */
// `as` cast permitted (CLAUDE.md): the verify-failed and wrong_token_type
// branches return before any DB call runs (`refreshAccessToken` does
// `jwtVerify` then a type-check before its first `db.select`), so the
// sentinel never gets dereferenced.
const NEVER_USED_DB = null as unknown as Database;

const SECRET = "test-jwt-secret-key-for-vitest";
const WRONG_SECRET = "this-is-the-wrong-secret-key-on-purpose";
const EXPIRIES = { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" };

async function signRefreshToken(opts: { sub: string; secret?: string; expiry?: string | number; type?: string }) {
  const secret = new TextEncoder().encode(opts.secret ?? SECRET);
  return new SignJWT({ sub: opts.sub, type: opts.type ?? "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti("jti-test")
    .setExpirationTime(opts.expiry ?? "30d")
    .sign(secret);
}

describe("/auth/refresh failure attrs (issue #246)", () => {
  it("classifies an expired token as jwt_expired and stamps untrusted sub", async () => {
    // Absolute past timestamp: avoids the 5ms-sleep flake from relying on
    // jose stamping `exp = now` and the clock crossing it during the test.
    const pastEpoch = Math.floor(Date.now() / 1000) - 60;
    const expired = await signRefreshToken({ sub: "user-expired", expiry: pastEpoch });

    await expect(refreshAccessToken(NEVER_USED_DB, expired, SECRET, EXPIRIES)).rejects.toMatchObject({
      statusCode: 401,
      attrs: expect.objectContaining({
        "auth.refresh.reason": "jwt_expired",
        "auth.refresh.untrusted.sub": "user-expired",
      }),
    } satisfies Partial<AppError>);
  });

  it("classifies a wrong-signature token as jwt_signature_invalid and still recovers untrusted sub", async () => {
    const tampered = await signRefreshToken({ sub: "user-sig", secret: WRONG_SECRET });

    await expect(refreshAccessToken(NEVER_USED_DB, tampered, SECRET, EXPIRIES)).rejects.toMatchObject({
      statusCode: 401,
      attrs: expect.objectContaining({
        "auth.refresh.reason": "jwt_signature_invalid",
        "auth.refresh.untrusted.sub": "user-sig",
      }),
    });
  });

  it("classifies a malformed token as jwt_malformed (no untrusted attrs)", async () => {
    await expect(refreshAccessToken(NEVER_USED_DB, "not.a.jwt", SECRET, EXPIRIES)).rejects.toMatchObject({
      statusCode: 401,
      attrs: expect.objectContaining({
        "auth.refresh.reason": "jwt_malformed",
      }),
    });
  });
});

describe("/auth/connect-token failure attrs", () => {
  it("classifies an expired connect token and stamps untrusted sub on the connect namespace", async () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 60;
    const expired = await signRefreshToken({ sub: "user-cx", type: "connect", expiry: pastEpoch });

    await expect(exchangeConnectToken(NEVER_USED_DB, expired, SECRET, EXPIRIES)).rejects.toMatchObject({
      statusCode: 401,
      attrs: expect.objectContaining({
        "auth.connect.reason": "jwt_expired",
        "auth.connect.untrusted.sub": "user-cx",
      }),
    });
  });

  it("rejects a refresh token presented as a connect token with wrong_token_type + actual_type", async () => {
    // Valid signature, valid claims, but `type: "refresh"` — `exchangeConnectToken`
    // hits its post-verify type guard and we want the dashboard to be able to tell
    // "wrong type" from "verify failed" without stack-grepping.
    const refreshTypedToken = await signRefreshToken({ sub: "user-rt", type: "refresh" });

    await expect(exchangeConnectToken(NEVER_USED_DB, refreshTypedToken, SECRET, EXPIRIES)).rejects.toMatchObject({
      statusCode: 401,
      attrs: expect.objectContaining({
        "auth.connect.reason": "wrong_token_type",
        "auth.connect.actual_type": "refresh",
      }),
    });
  });
});
