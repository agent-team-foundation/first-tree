import { describe, expect, it } from "vitest";
import { __testing } from "../core/daemon-auth.js";

const { decodeExp, isExpired } = __testing;

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature-not-verified`;
}

describe("decodeExp", () => {
  it("returns the exp claim when present", () => {
    expect(decodeExp(jwt({ exp: 1234567890 }))).toBe(1234567890);
  });

  it("returns null when exp is missing", () => {
    expect(decodeExp(jwt({ sub: "u1" }))).toBeNull();
  });

  it("returns null on malformed JWTs", () => {
    expect(decodeExp("not.a.jwt")).toBeNull();
    expect(decodeExp("only-one-segment")).toBeNull();
    expect(decodeExp("")).toBeNull();
  });
});

describe("isExpired", () => {
  it("treats malformed tokens as expired", () => {
    expect(isExpired("garbage")).toBe(true);
  });

  it("returns false when exp is well in the future", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isExpired(jwt({ exp: future }))).toBe(false);
  });

  it("returns true when exp is already past", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(isExpired(jwt({ exp: past }))).toBe(true);
  });

  it("treats tokens within the 30s leeway window as expired", () => {
    const aboutToExpire = Math.floor(Date.now() / 1000) + 10;
    expect(isExpired(jwt({ exp: aboutToExpire }))).toBe(true);
  });
});
