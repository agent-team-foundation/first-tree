import { describe, expect, it } from "vitest";
import { decodeJwtPayload, deriveHubUrlFromToken, HubUrlDerivationError } from "../commands/_shared/connect-token.js";

/** Build a fake JWT (no signing — payload-only). */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  // CLI never verifies the signature locally — it's enforced by the server
  // on exchange. The trailing string just has to look like a JWT segment.
  return `${header}.${body}.signature`;
}

describe("deriveHubUrlFromToken", () => {
  it("returns the fallback URL for a bare short connect code", () => {
    expect(deriveHubUrlFromToken("abc_DEF-1234567890xyz", "https://first-tree.example.com/")).toBe(
      "https://first-tree.example.com",
    );
  });

  it("returns the iss claim verbatim when present", () => {
    const token = fakeJwt({ iss: "https://first-tree.example.com", type: "connect" });
    expect(deriveHubUrlFromToken(token)).toBe("https://first-tree.example.com");
  });

  it("strips trailing slashes", () => {
    const token = fakeJwt({ iss: "https://first-tree.example.com//" });
    expect(deriveHubUrlFromToken(token)).toBe("https://first-tree.example.com");
  });

  it("supports http for local dev", () => {
    const token = fakeJwt({ iss: "http://localhost:8000" });
    expect(deriveHubUrlFromToken(token)).toBe("http://localhost:8000");
  });

  it("hard-fails when iss is missing", () => {
    const token = fakeJwt({ type: "connect" });
    try {
      deriveHubUrlFromToken(token);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HubUrlDerivationError);
      expect((err as HubUrlDerivationError).code).toBe("TOKEN_MISSING_ISS");
    }
  });

  it("hard-fails when iss is empty", () => {
    const token = fakeJwt({ iss: "" });
    expect(() => deriveHubUrlFromToken(token)).toThrow(HubUrlDerivationError);
  });

  it("hard-fails when iss is not http(s)", () => {
    const token = fakeJwt({ iss: "ftp://first-tree.example.com" });
    try {
      deriveHubUrlFromToken(token);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HubUrlDerivationError);
      expect((err as HubUrlDerivationError).code).toBe("TOKEN_BAD_ISS");
    }
  });

  it("hard-fails when token is not a valid JWT", () => {
    expect(() => deriveHubUrlFromToken("not.a.jwt-at-all")).toThrow(HubUrlDerivationError);
    try {
      deriveHubUrlFromToken("garbage", "https://first-tree.example.com");
    } catch (err) {
      expect((err as HubUrlDerivationError).code).toBe("INVALID_TOKEN");
    }
  });

  it("hard-fails when given a connect URL instead of a short code", () => {
    try {
      deriveHubUrlFromToken("https://first-tree.example.com/connect/abc_DEF-123", "https://first-tree.example.com");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HubUrlDerivationError);
      expect((err as HubUrlDerivationError).code).toBe("TOKEN_BAD_URL");
    }
  });
});

describe("decodeJwtPayload", () => {
  it("decodes a payload-only token", () => {
    const token = fakeJwt({ memberId: "abc123", iss: "https://first-tree.example.com" });
    expect(decodeJwtPayload(token)).toMatchObject({ memberId: "abc123" });
  });

  it("returns null on garbage", () => {
    expect(decodeJwtPayload("garbage")).toBeNull();
    expect(decodeJwtPayload("a.b")).toBeNull();
  });
});
