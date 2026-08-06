import { createHash, randomBytes } from "node:crypto";
import * as jose from "jose";

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
};

export type OidcTokenSet = {
  access_token: string;
  id_token: string;
  token_type: string;
};

export type OidcIdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;
};

let cachedDiscovery: { issuer: string; doc: OidcDiscovery; expiresAt: number } | undefined;

export async function fetchDiscovery(issuer: string): Promise<OidcDiscovery> {
  if (cachedDiscovery && cachedDiscovery.issuer === issuer && Date.now() < cachedDiscovery.expiresAt) {
    return cachedDiscovery.doc;
  }
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
  const doc = (await res.json()) as OidcDiscovery;
  if (doc.issuer !== issuer) {
    throw new Error(`OIDC issuer mismatch: expected ${issuer}, got ${doc.issuer}`);
  }
  cachedDiscovery = { issuer, doc, expiresAt: Date.now() + 5 * 60 * 1000 };
  return doc;
}

export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export async function exchangeOidcCode(opts: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
}): Promise<OidcTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: opts.codeVerifier,
  });
  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OIDC token exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as OidcTokenSet;
}

export async function verifyIdToken(opts: {
  idToken: string;
  jwksUri: string;
  issuer: string;
  clientId: string;
  nonce: string;
}): Promise<OidcIdTokenClaims> {
  const jwks = jose.createRemoteJWKSet(new URL(opts.jwksUri));
  const { payload } = await jose.jwtVerify(opts.idToken, jwks, {
    issuer: opts.issuer,
    audience: opts.clientId,
  });
  const claims = payload as unknown as OidcIdTokenClaims;
  if (claims.nonce !== opts.nonce) {
    throw new Error("OIDC id_token nonce mismatch");
  }
  return claims;
}

export async function fetchUserInfo(opts: {
  userInfoEndpoint: string;
  accessToken: string;
  expectedSub: string;
}): Promise<OidcIdTokenClaims> {
  const res = await fetch(opts.userInfoEndpoint, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) throw new Error(`OIDC userinfo failed: ${res.status}`);
  const info = (await res.json()) as OidcIdTokenClaims;
  if (info.sub !== opts.expectedSub) {
    throw new Error("OIDC userinfo sub does not match id_token sub");
  }
  return info;
}
