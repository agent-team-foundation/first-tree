import { createHash, randomBytes } from "node:crypto";
import * as jose from "jose";

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
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
  azp?: string;
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`OIDC discovery failed with status ${res.status}`);
    }
    const json = (await res.json()) as Record<string, unknown>;

    // Runtime validation of discovery document
    if (typeof json !== "object" || json === null) {
      throw new Error("OIDC discovery response is not an object");
    }
    if (typeof json.issuer !== "string" || !json.issuer) {
      throw new Error("OIDC discovery missing issuer");
    }
    if (json.issuer !== issuer) {
      throw new Error(`OIDC issuer mismatch: expected ${issuer}, got ${json.issuer}`);
    }
    if (typeof json.authorization_endpoint !== "string" || !json.authorization_endpoint) {
      throw new Error("OIDC discovery missing authorization_endpoint");
    }
    if (typeof json.token_endpoint !== "string" || !json.token_endpoint) {
      throw new Error("OIDC discovery missing token_endpoint");
    }
    if (typeof json.jwks_uri !== "string" || !json.jwks_uri) {
      throw new Error("OIDC discovery missing jwks_uri");
    }

    // Parse and validate signing algorithms
    let signingAlgs: string[] | undefined;
    if (json.id_token_signing_alg_values_supported !== undefined) {
      if (!Array.isArray(json.id_token_signing_alg_values_supported)) {
        throw new Error("OIDC discovery id_token_signing_alg_values_supported must be an array");
      }
      signingAlgs = json.id_token_signing_alg_values_supported.filter(
        (alg): alg is string => typeof alg === "string" && alg.length > 0,
      );
      if (signingAlgs.length === 0) {
        throw new Error("OIDC discovery id_token_signing_alg_values_supported contains no valid algorithms");
      }
    }

    const doc: OidcDiscovery = {
      issuer: json.issuer,
      authorization_endpoint: json.authorization_endpoint,
      token_endpoint: json.token_endpoint,
      jwks_uri: json.jwks_uri,
      userinfo_endpoint:
        typeof json.userinfo_endpoint === "string" && json.userinfo_endpoint ? json.userinfo_endpoint : undefined,
      id_token_signing_alg_values_supported: signingAlgs,
    };

    // In production, enforce HTTPS for all endpoints
    if (process.env.NODE_ENV === "production") {
      const endpoints = [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri];
      if (doc.userinfo_endpoint) {
        endpoints.push(doc.userinfo_endpoint);
      }
      for (const endpoint of endpoints) {
        if (!endpoint.startsWith("https://")) {
          throw new Error(`OIDC endpoint must use HTTPS in production: ${endpoint}`);
        }
      }
    }

    cachedDiscovery = { issuer, doc, expiresAt: Date.now() + 5 * 60 * 1000 };
    return doc;
  } finally {
    clearTimeout(timeoutId);
  }
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const res = await fetch(opts.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`OIDC token exchange failed with status ${res.status}`);
    }
    const json = (await res.json()) as Record<string, unknown>;

    // Runtime validation of token response
    if (typeof json !== "object" || json === null) {
      throw new Error("OIDC token response is not an object");
    }
    if (typeof json.access_token !== "string" || !json.access_token) {
      throw new Error("OIDC token response missing access_token");
    }
    if (typeof json.id_token !== "string" || !json.id_token) {
      throw new Error("OIDC token response missing id_token");
    }
    if (typeof json.token_type !== "string" || !json.token_type) {
      throw new Error("OIDC token response missing token_type");
    }

    return {
      access_token: json.access_token,
      id_token: json.id_token,
      token_type: json.token_type,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function verifyIdToken(opts: {
  idToken: string;
  jwksUri: string;
  issuer: string;
  clientId: string;
  nonce: string;
  algorithms?: string[];
}): Promise<OidcIdTokenClaims> {
  const jwks = jose.createRemoteJWKSet(new URL(opts.jwksUri));
  // Use algorithms from discovery if provided, otherwise fall back to common secure algorithms
  const allowedAlgorithms = opts.algorithms ?? ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"];
  const { payload } = await jose.jwtVerify(opts.idToken, jwks, {
    issuer: opts.issuer,
    audience: opts.clientId,
    algorithms: allowedAlgorithms,
  });

  // Runtime validation: jose.jwtVerify checks exp/iss/aud, but we need explicit sub/iat/nonce checks
  if (typeof payload !== "object" || payload === null) {
    throw new Error("OIDC id_token payload is not an object");
  }
  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.trim() === "") {
    throw new Error("OIDC id_token missing or invalid sub claim");
  }
  if (!payload.iat || typeof payload.iat !== "number") {
    throw new Error("OIDC id_token missing iat claim");
  }
  if (!payload.exp || typeof payload.exp !== "number") {
    throw new Error("OIDC id_token missing exp claim");
  }

  const claims = payload as OidcIdTokenClaims;

  // Validate nonce
  if (claims.nonce !== opts.nonce) {
    throw new Error("OIDC id_token nonce mismatch");
  }

  // Validate iat is recent (within last 10 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + 60) {
    throw new Error("OIDC id_token iat is in the future");
  }
  if (now - claims.iat > 600) {
    throw new Error("OIDC id_token iat is too old (>10 minutes)");
  }

  // Validate azp when aud is an array with multiple values
  if (Array.isArray(claims.aud) && claims.aud.length > 1) {
    if (!claims.azp || typeof claims.azp !== "string") {
      throw new Error("OIDC id_token with multiple audiences must have azp claim");
    }
    if (claims.azp !== opts.clientId) {
      throw new Error("OIDC id_token azp does not match client_id");
    }
  }

  return claims;
}

export async function fetchUserInfo(opts: {
  userInfoEndpoint: string;
  accessToken: string;
  expectedSub: string;
}): Promise<OidcIdTokenClaims> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const res = await fetch(opts.userInfoEndpoint, {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`OIDC userinfo failed with status ${res.status}`);
    }
    const json = (await res.json()) as Record<string, unknown>;

    // Runtime validation of UserInfo response
    if (typeof json !== "object" || json === null) {
      throw new Error("OIDC userinfo response is not an object");
    }
    if (typeof json.sub !== "string" || !json.sub) {
      throw new Error("OIDC userinfo missing or invalid sub");
    }
    if (json.sub !== opts.expectedSub) {
      throw new Error("OIDC userinfo sub does not match id_token sub");
    }

    // Validate optional profile fields by type
    if (json.name !== undefined && typeof json.name !== "string") {
      throw new Error("OIDC userinfo name must be a string");
    }
    if (json.nickname !== undefined && typeof json.nickname !== "string") {
      throw new Error("OIDC userinfo nickname must be a string");
    }
    if (json.preferred_username !== undefined && typeof json.preferred_username !== "string") {
      throw new Error("OIDC userinfo preferred_username must be a string");
    }
    if (json.picture !== undefined && typeof json.picture !== "string") {
      throw new Error("OIDC userinfo picture must be a string");
    }
    if (json.email !== undefined && typeof json.email !== "string") {
      throw new Error("OIDC userinfo email must be a string");
    }
    if (json.email_verified !== undefined && typeof json.email_verified !== "boolean") {
      throw new Error("OIDC userinfo email_verified must be a boolean");
    }

    return json as OidcIdTokenClaims;
  } finally {
    clearTimeout(timeoutId);
  }
}
