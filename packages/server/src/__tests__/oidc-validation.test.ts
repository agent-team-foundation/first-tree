import { describe, expect, it } from "vitest";
import { verifyIdToken } from "../services/oidc.js";
import * as jose from "jose";

describe("OIDC ID token validation", () => {
  it("rejects id_token with missing sub", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwks = jose.createLocalJWKSet({
      keys: [await jose.exportJWK(publicKey)],
    });

    const token = await new jose.SignJWT({ iss: "https://idp.test", aud: "client-id", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    // Mock createRemoteJWKSet to return local JWKS
    const originalCreateRemoteJWKSet = jose.createRemoteJWKSet;
    (jose as any).createRemoteJWKSet = () => jwks;

    try {
      await expect(
        verifyIdToken({
          idToken: token,
          jwksUri: "https://idp.test/jwks",
          issuer: "https://idp.test",
          clientId: "client-id",
          nonce: "test-nonce",
        })
      ).rejects.toThrow(/missing or invalid sub/);
    } finally {
      (jose as any).createRemoteJWKSet = originalCreateRemoteJWKSet;
    }
  });

  it("rejects id_token with empty sub", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwks = jose.createLocalJWKSet({
      keys: [await jose.exportJWK(publicKey)],
    });

    const token = await new jose.SignJWT({ iss: "https://idp.test", sub: "", aud: "client-id", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const originalCreateRemoteJWKSet = jose.createRemoteJWKSet;
    (jose as any).createRemoteJWKSet = () => jwks;

    try {
      await expect(
        verifyIdToken({
          idToken: token,
          jwksUri: "https://idp.test/jwks",
          issuer: "https://idp.test",
          clientId: "client-id",
          nonce: "test-nonce",
        })
      ).rejects.toThrow(/missing or invalid sub/);
    } finally {
      (jose as any).createRemoteJWKSet = originalCreateRemoteJWKSet;
    }
  });

  it("rejects id_token with missing iat", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwks = jose.createLocalJWKSet({
      keys: [await jose.exportJWK(publicKey)],
    });

    const token = await new jose.SignJWT({ iss: "https://idp.test", sub: "user123", aud: "client-id", exp: Math.floor(Date.now() / 1000) + 300, nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const originalCreateRemoteJWKSet = jose.createRemoteJWKSet;
    (jose as any).createRemoteJWKSet = () => jwks;

    try {
      await expect(
        verifyIdToken({
          idToken: token,
          jwksUri: "https://idp.test/jwks",
          issuer: "https://idp.test",
          clientId: "client-id",
          nonce: "test-nonce",
        })
      ).rejects.toThrow(/missing iat/);
    } finally {
      (jose as any).createRemoteJWKSet = originalCreateRemoteJWKSet;
    }
  });

  it("rejects id_token with iat in the future", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwks = jose.createLocalJWKSet({
      keys: [await jose.exportJWK(publicKey)],
    });

    const futureIat = Math.floor(Date.now() / 1000) + 120;
    const token = await new jose.SignJWT({ iss: "https://idp.test", sub: "user123", aud: "client-id", exp: futureIat + 300, iat: futureIat, nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const originalCreateRemoteJWKSet = jose.createRemoteJWKSet;
    (jose as any).createRemoteJWKSet = () => jwks;

    try {
      await expect(
        verifyIdToken({
          idToken: token,
          jwksUri: "https://idp.test/jwks",
          issuer: "https://idp.test",
          clientId: "client-id",
          nonce: "test-nonce",
        })
      ).rejects.toThrow(/iat is in the future/);
    } finally {
      (jose as any).createRemoteJWKSet = originalCreateRemoteJWKSet;
    }
  });

  it("requires azp when aud is array", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwks = jose.createLocalJWKSet({
      keys: [await jose.exportJWK(publicKey)],
    });

    const token = await new jose.SignJWT({ iss: "https://idp.test", sub: "user123", aud: ["client-id", "other-client"], exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const originalCreateRemoteJWKSet = jose.createRemoteJWKSet;
    (jose as any).createRemoteJWKSet = () => jwks;

    try {
      await expect(
        verifyIdToken({
          idToken: token,
          jwksUri: "https://idp.test/jwks",
          issuer: "https://idp.test",
          clientId: "client-id",
          nonce: "test-nonce",
        })
      ).rejects.toThrow(/must have azp/);
    } finally {
      (jose as any).createRemoteJWKSet = originalCreateRemoteJWKSet;
    }
  });

  it("verifies azp matches client_id when aud is array", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwks = jose.createLocalJWKSet({
      keys: [await jose.exportJWK(publicKey)],
    });

    const token = await new jose.SignJWT({ iss: "https://idp.test", sub: "user123", aud: ["client-id", "other-client"], azp: "wrong-client", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: "test-nonce" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const originalCreateRemoteJWKSet = jose.createRemoteJWKSet;
    (jose as any).createRemoteJWKSet = () => jwks;

    try {
      await expect(
        verifyIdToken({
          idToken: token,
          jwksUri: "https://idp.test/jwks",
          issuer: "https://idp.test",
          clientId: "client-id",
          nonce: "test-nonce",
        })
      ).rejects.toThrow(/azp does not match/);
    } finally {
      (jose as any).createRemoteJWKSet = originalCreateRemoteJWKSet;
    }
  });

  it("accepts valid id_token with all required claims", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const jwks = jose.createLocalJWKSet({
      keys: [await jose.exportJWK(publicKey)],
    });

    const now = Math.floor(Date.now() / 1000);
    const token = await new jose.SignJWT({
      iss: "https://idp.test",
      sub: "user123",
      aud: "client-id",
      exp: now + 300,
      iat: now,
      nonce: "test-nonce",
      email: "user@example.com",
      email_verified: true
    })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const originalCreateRemoteJWKSet = jose.createRemoteJWKSet;
    (jose as any).createRemoteJWKSet = () => jwks;

    try {
      const claims = await verifyIdToken({
        idToken: token,
        jwksUri: "https://idp.test/jwks",
        issuer: "https://idp.test",
        clientId: "client-id",
        nonce: "test-nonce",
      });
      expect(claims.sub).toBe("user123");
      expect(claims.email).toBe("user@example.com");
      expect(claims.email_verified).toBe(true);
    } finally {
      (jose as any).createRemoteJWKSet = originalCreateRemoteJWKSet;
    }
  });
});
