import { errors, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { classifyJoseError, decodeJwtForTrace, untrustedAttrs } from "../jwt-trace.js";

describe("classifyJoseError", () => {
  it("maps ERR_JWT_EXPIRED to jwt_expired", () => {
    expect(classifyJoseError(new errors.JWTExpired("expired", { type: "refresh" }))).toBe("jwt_expired");
  });

  it("maps ERR_JWS_SIGNATURE_VERIFICATION_FAILED to jwt_signature_invalid", () => {
    expect(classifyJoseError(new errors.JWSSignatureVerificationFailed())).toBe("jwt_signature_invalid");
  });

  it("maps ERR_JWT_INVALID and ERR_JWS_INVALID to jwt_malformed", () => {
    expect(classifyJoseError(new errors.JWTInvalid("malformed"))).toBe("jwt_malformed");
    expect(classifyJoseError(new errors.JWSInvalid())).toBe("jwt_malformed");
  });

  it("falls through to jwt_verify_failed for unknown shapes", () => {
    expect(classifyJoseError(new Error("nope"))).toBe("jwt_verify_failed");
    expect(classifyJoseError(undefined)).toBe("jwt_verify_failed");
    expect(classifyJoseError({ code: 42 })).toBe("jwt_verify_failed");
  });
});

describe("decodeJwtForTrace", () => {
  it("returns claims for a syntactically valid token without verifying signature", async () => {
    const secret = new TextEncoder().encode("anything-not-the-real-key");
    const token = await new SignJWT({ sub: "user-123", type: "refresh" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(1_700_003_600)
      .setJti("jti-xyz")
      .sign(secret);

    const out = decodeJwtForTrace(token);
    expect(out).toEqual({
      sub: "user-123",
      type: "refresh",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      jti: "jti-xyz",
    });
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtForTrace("")).toBeNull();
    expect(decodeJwtForTrace("not.a.jwt")).toBeNull();
    expect(decodeJwtForTrace("garbage")).toBeNull();
  });

  it("ignores claim fields with unexpected types", async () => {
    // jose's decodeJwt accepts any JSON; we narrow per-field so a hostile
    // payload like `{sub: 42}` doesn't poison the trace span.
    // Cast through unknown — jose's setExpirationTime types reject non-number
    // `iat` at compile time, but the on-the-wire payload can carry anything.
    const secret = new TextEncoder().encode("k");
    const token = await new SignJWT({ sub: "ok", iat: "string-not-number" as unknown as number })
      .setProtectedHeader({ alg: "HS256" })
      .sign(secret);
    const out = decodeJwtForTrace(token);
    expect(out?.sub).toBe("ok");
    expect(out?.iat).toBeUndefined();
  });
});

describe("untrustedAttrs", () => {
  it("returns empty object when claims are null", () => {
    expect(untrustedAttrs("auth.refresh", null)).toEqual({});
  });

  it("prefixes set fields and omits absent ones", () => {
    expect(untrustedAttrs("auth.refresh", { sub: "u", exp: 100 })).toEqual({
      "auth.refresh.untrusted.sub": "u",
      "auth.refresh.untrusted.exp": 100,
    });
  });

  it("includes the type field when present so dashboards can distinguish refresh vs connect tokens", () => {
    expect(untrustedAttrs("auth.refresh", { sub: "u", type: "refresh", jti: "j", iat: 1, exp: 2 })).toEqual({
      "auth.refresh.untrusted.sub": "u",
      "auth.refresh.untrusted.type": "refresh",
      "auth.refresh.untrusted.jti": "j",
      "auth.refresh.untrusted.iat": 1,
      "auth.refresh.untrusted.exp": 2,
    });
  });
});
