import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createCandidateTokenSnapshot,
  encodeLengthFramedUtf8,
  fingerprintCandidateTokenSnapshot,
} from "../session/candidate-tokens.js";

function base64Url(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function token(payload: unknown): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}.signature`;
}

function pair(
  accountId = "account-a",
  accessExpiresAt = 2_000_000_000,
  refreshExpiresAt = 2_100_000_000,
): Readonly<{ accessToken: string; refreshToken: string }> {
  return {
    accessToken: token({ sub: accountId, type: "access", exp: accessExpiresAt }),
    refreshToken: token({ sub: accountId, type: "refresh", exp: refreshExpiresAt }),
  };
}

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  }
});

describe("candidate token snapshots", () => {
  it("structurally binds access and refresh subjects without treating them as verified", () => {
    const snapshot = createCandidateTokenSnapshot(pair("account-a"));
    expect(snapshot).toMatchObject({
      accountIdCandidate: "account-a",
      accessExpiresAt: 2_000_000_000_000,
      refreshExpiresAt: 2_100_000_000_000,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects wrong token kinds and cross-account pairs", () => {
    expect(() =>
      createCandidateTokenSnapshot({
        accessToken: token({ sub: "account-a", type: "refresh", exp: 2_000_000_000 }),
        refreshToken: token({ sub: "account-a", type: "refresh", exp: 2_100_000_000 }),
      }),
    ).toThrow("type");
    expect(() =>
      createCandidateTokenSnapshot({
        accessToken: token({ sub: "account-a", type: "access", exp: 2_000_000_000 }),
        refreshToken: token({ sub: "account-b", type: "refresh", exp: 2_100_000_000 }),
      }),
    ).toThrow("subjects do not match");
  });

  it.each([
    ["not-a-jwt", token({ sub: "account-a", type: "refresh", exp: 2_100_000_000 })],
    ["a.%ZZ.c", token({ sub: "account-a", type: "refresh", exp: 2_100_000_000 })],
    [token({ sub: "", type: "access", exp: 2_000_000_000 }), token({ sub: "", type: "refresh", exp: 2_100_000_000 })],
    [token({ sub: "account-a", type: "access" }), token({ sub: "account-a", type: "refresh", exp: 2_100_000_000 })],
    [
      token({ sub: "account-a", type: "access", exp: -1 }),
      token({ sub: "account-a", type: "refresh", exp: 2_100_000_000 }),
    ],
  ])("fails closed for malformed token pairs", (accessToken, refreshToken) => {
    expect(() => createCandidateTokenSnapshot({ accessToken, refreshToken })).toThrow();
  });

  it("uses versioned length framing so adjacent values cannot collide", () => {
    expect([...encodeLengthFramedUtf8(["ab", "c"])]).not.toEqual([...encodeLengthFramedUtf8(["a", "bc"])]);
  });

  it("binds the fingerprint to authority, subject, and exact token bytes", async () => {
    const first = await fingerprintCandidateTokenSnapshot(
      createCandidateTokenSnapshot(pair("account-a")),
      "https://s1.example/api/v1",
    );
    const same = await fingerprintCandidateTokenSnapshot(
      createCandidateTokenSnapshot(pair("account-a")),
      "https://s1.example/api/v1/",
    );
    const anotherAuthority = await fingerprintCandidateTokenSnapshot(
      createCandidateTokenSnapshot(pair("account-a")),
      "https://s2.example/api/v1",
    );
    const anotherPair = await fingerprintCandidateTokenSnapshot(
      createCandidateTokenSnapshot(pair("account-a", 2_000_000_001)),
      "https://s1.example/api/v1",
    );

    expect(first.credentialFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(same.credentialFingerprint).toBe(first.credentialFingerprint);
    expect(anotherAuthority.credentialFingerprint).not.toBe(first.credentialFingerprint);
    expect(anotherPair.credentialFingerprint).not.toBe(first.credentialFingerprint);
  });
});
