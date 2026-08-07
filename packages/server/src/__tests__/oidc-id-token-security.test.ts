import { createServer, type Server } from "node:http";
import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyIdToken } from "../services/oidc.js";

/**
 * ID token security boundary tests using real signed JWTs and the actual
 * verifyIdToken() function from services/oidc.ts.
 *
 * Strategy: Create a local HTTP server serving JWKS, generate real RSA keys,
 * sign JWTs with jose, and call verifyIdToken() which will fetch the JWKS
 * and perform all First Tree's custom checks (sub, iat, nonce, azp, etc.)
 */

const ISSUER = "https://idp.test";
const CLIENT_ID = "test-client-id";
const NONCE = "test-nonce-12345";

let privateKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["privateKey"];
let publicJWK: jose.JWK;
let kid: string;
let jwksServer: Server;
let jwksUri: string;

beforeAll(async () => {
  // Generate RSA key pair for signing/verifying test tokens
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("RS256");
  privateKey = priv;
  kid = "test-key-id";

  // Export public key as JWK for JWKS endpoint
  publicJWK = await jose.exportJWK(publicKey);
  publicJWK.kid = kid;
  publicJWK.alg = "RS256";
  publicJWK.use = "sig";

  // Create HTTP server to serve JWKS
  jwksServer = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJWK] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // Start server on random port
  await new Promise<void>((resolve) => {
    jwksServer.listen(0, () => {
      const addr = jwksServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      jwksUri = `http://localhost:${port}/.well-known/jwks.json`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((err) => (err ? reject(err) : resolve()));
  });
});

/**
 * Sign a JWT with the test private key.
 */
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

/**
 * Call the real verifyIdToken() from services/oidc.ts
 */
async function callVerifyIdToken(idToken: string): Promise<ReturnType<typeof verifyIdToken>> {
  return verifyIdToken({
    idToken,
    jwksUri,
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
    const token = await signToken({
      aud: [CLIENT_ID, "other-client"],
      azp: CLIENT_ID,
    });
    const claims = await callVerifyIdToken(token);
    expect(claims.aud).toEqual([CLIENT_ID, "other-client"]);
    expect(claims.azp).toBe(CLIENT_ID);
  });

  it("rejects multi-audience token with mismatched azp", async () => {
    const token = await signToken({
      aud: [CLIENT_ID, "other-client"],
      azp: "wrong-client",
    });
    await expect(callVerifyIdToken(token)).rejects.toThrow("azp");
  });

  it("rejects multi-audience token without azp", async () => {
    const jwt = new jose.SignJWT({
      sub: "test-subject",
      nonce: NONCE,
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience([CLIENT_ID, "other-client"])
      .setExpirationTime("1h");
    const token = await jwt.sign(privateKey);
    await expect(callVerifyIdToken(token)).rejects.toThrow("azp");
  });

  it("rejects unsigned token", async () => {
    // Create an unsigned JWT (alg: none)
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

  it("rejects token with HS256 when only RS256 is allowed", async () => {
    // Generate HS256 key and sign token
    const hmacSecret = new Uint8Array(32);
    const hsToken = await new jose.SignJWT({
      sub: "test-subject",
      nonce: NONCE,
    })
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
