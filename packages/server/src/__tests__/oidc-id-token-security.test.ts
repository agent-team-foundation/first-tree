import * as jose from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyIdToken } from "../services/oidc.js";

/**
 * ID token security boundary tests using real signed JWTs and the actual
 * verifyIdToken() function from services/oidc.ts.
 *
 * Strategy: Generate real RSA keys, sign JWTs, and mock global.fetch to
 * intercept the jose.createRemoteJWKSet HTTP call. This exercises all of
 * First Tree's custom security checks (sub, iat, nonce, azp, etc.) without
 * relying on a real network connection — stable in both local and CI.
 */

const ISSUER = "https://idp.test";
const CLIENT_ID = "test-client-id";
const JWKS_URI = "https://idp.test/.well-known/jwks.json";
const NONCE = "test-nonce-12345";

let privateKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["privateKey"];
let publicJWK: jose.JWK;
let kid: string;

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("RS256");
  privateKey = priv;
  kid = "test-key-id";
  publicJWK = await jose.exportJWK(publicKey);
  publicJWK.kid = kid;
  publicJWK.alg = "RS256";
  publicJWK.use = "sig";
});

beforeEach(() => {
  // Mock global.fetch so jose.createRemoteJWKSet returns our test public key
  // without making a real HTTP request. This works in CI and locally.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      if (url === JWKS_URI) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: [publicJWK] }),
          headers: { get: () => "application/json" },
        };
      }
      return { ok: false, status: 404 };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    sub: "test-subject",
    nonce: NONCE,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt((claims.iat as number | undefined) ?? now)
    .setIssuer((claims.iss as string | undefined) ?? ISSUER)
    .setAudience((claims.aud as string | string[] | undefined) ?? CLIENT_ID)
    .setExpirationTime((claims.exp as number | undefined) ?? now + 3600)
    .sign(privateKey);
}

async function callVerifyIdToken(idToken: string): Promise<ReturnType<typeof verifyIdToken>> {
  return verifyIdToken({
    idToken,
    jwksUri: JWKS_URI,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    nonce: NONCE,
    algorithms: ["RS256"],
  });
}

describe("verifyIdToken security boundaries", () => {
  it("accepts valid token with all required claims", async () => {
    const token = await signToken({});
    const claims = await callVerifyIdToken(token);
    expect(claims.sub).toBe("test-subject");
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(CLIENT_ID);
    expect(claims.nonce).toBe(NONCE);
  });

  it("rejects token with empty sub", async () => {
    const token = await signToken({ sub: "" });
    await expect(callVerifyIdToken(token)).rejects.toThrow("sub");
  });

  it("rejects token with missing sub", async () => {
    const jwt = new jose.SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h");
    const token = await jwt.sign(privateKey);
    await expect(callVerifyIdToken(token)).rejects.toThrow("sub");
  });

  it("rejects token with non-string sub", async () => {
    const token = await signToken({ sub: 12345 });
    await expect(callVerifyIdToken(token)).rejects.toThrow("sub");
  });

  it("rejects token with missing iat", async () => {
    const jwt = new jose.SignJWT({ sub: "test-subject", nonce: NONCE })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h");
    const token = await jwt.sign(privateKey);
    await expect(callVerifyIdToken(token)).rejects.toThrow("iat");
  });

  it("rejects token with future iat", async () => {
    const futureIat = Math.floor(Date.now() / 1000) + 120;
    const token = await signToken({ iat: futureIat });
    await expect(callVerifyIdToken(token)).rejects.toThrow("future");
  });

  it("rejects token with old iat (>10 minutes)", async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 650;
    const token = await signToken({ iat: oldIat });
    await expect(callVerifyIdToken(token)).rejects.toThrow("too old");
  });

  it("rejects token with nonce mismatch", async () => {
    const token = await signToken({ nonce: "wrong-nonce" });
    await expect(callVerifyIdToken(token)).rejects.toThrow("nonce");
  });

  it("rejects token with missing nonce", async () => {
    const jwt = new jose.SignJWT({ sub: "test-subject" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h");
    const token = await jwt.sign(privateKey);
    await expect(callVerifyIdToken(token)).rejects.toThrow("nonce");
  });

  it("accepts single-audience token without azp", async () => {
    const token = await signToken({ aud: CLIENT_ID });
    const claims = await callVerifyIdToken(token);
    expect(claims.aud).toBe(CLIENT_ID);
    expect(claims.azp).toBeUndefined();
  });

  it("accepts multi-audience token with matching azp", async () => {
    const token = await signToken({ aud: [CLIENT_ID, "other-client"], azp: CLIENT_ID });
    const claims = await callVerifyIdToken(token);
    expect(claims.aud).toEqual([CLIENT_ID, "other-client"]);
    expect(claims.azp).toBe(CLIENT_ID);
  });

  it("rejects multi-audience token with mismatched azp", async () => {
    const token = await signToken({ aud: [CLIENT_ID, "other-client"], azp: "wrong-client" });
    await expect(callVerifyIdToken(token)).rejects.toThrow("azp");
  });

  it("rejects multi-audience token without azp", async () => {
    const jwt = new jose.SignJWT({ sub: "test-subject", nonce: NONCE })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience([CLIENT_ID, "other-client"])
      .setExpirationTime("1h");
    const token = await jwt.sign(privateKey);
    await expect(callVerifyIdToken(token)).rejects.toThrow("azp");
  });

  it("rejects unsigned token (alg: none)", async () => {
    const unsignedPayload = {
      iss: ISSUER,
      sub: "test-subject",
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nonce: NONCE,
    };
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(unsignedPayload)).toString("base64url");
    const unsignedToken = `${header}.${payload}.`;
    await expect(callVerifyIdToken(unsignedToken)).rejects.toThrow();
  });

  it("rejects token signed with HS256 when only RS256 is allowed", async () => {
    const hmacSecret = new Uint8Array(32);
    const hsToken = await new jose.SignJWT({ sub: "test-subject", nonce: NONCE })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime("1h")
      .sign(hmacSecret);
    await expect(callVerifyIdToken(hsToken)).rejects.toThrow();
  });

  it("rejects token with invalid email type", async () => {
    const token = await signToken({ email: 12345 });
    await expect(callVerifyIdToken(token)).rejects.toThrow("email");
  });

  it("rejects token with invalid email_verified type", async () => {
    const token = await signToken({ email_verified: "true" });
    await expect(callVerifyIdToken(token)).rejects.toThrow("email_verified");
  });

  it("rejects token with invalid name type", async () => {
    const token = await signToken({ name: 12345 });
    await expect(callVerifyIdToken(token)).rejects.toThrow("name");
  });
});
