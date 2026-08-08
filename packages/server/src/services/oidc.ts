import { createHash, randomBytes } from "node:crypto";
import * as jose from "jose";

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported: string[]; // Required, validated intersection with local supported algorithms
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

export type OidcUserInfoProfile = {
  sub: string;
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
  // OIDC Discovery §4.1: remove trailing slash before appending well-known suffix
  // but preserve the exact configured issuer for identity key comparison
  const discoveryBase = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const url = `${discoveryBase}/.well-known/openid-configuration`;
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

    // Parse and validate signing algorithms - REQUIRED
    // Require discovery to advertise supported algorithms
    if (!json.id_token_signing_alg_values_supported || !Array.isArray(json.id_token_signing_alg_values_supported)) {
      throw new Error("OIDC discovery must provide id_token_signing_alg_values_supported");
    }

    // First Tree's supported secure asymmetric algorithms
    const SUPPORTED_ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"];

    // Find intersection: algorithms both advertised by IdP and supported by us
    const advertisedAlgs = json.id_token_signing_alg_values_supported.filter(
      (alg): alg is string => typeof alg === "string" && alg.length > 0,
    );
    const signingAlgs = advertisedAlgs.filter((alg) => SUPPORTED_ALGORITHMS.includes(alg));

    if (signingAlgs.length === 0) {
      // Do not log provider-controlled algorithm list to prevent log injection
      throw new Error("OIDC discovery advertises no supported signing algorithms");
    }

    // Parse and validate endpoint URLs
    const parseAndValidateUrl = (urlString: string, name: string): URL => {
      let url: URL;
      try {
        url = new URL(urlString);
      } catch (err) {
        // Do not log the URL string to prevent log injection of malformed URLs
        throw new Error(`OIDC ${name} is not a valid URL`);
      }
      // In production, enforce HTTPS
      if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
        // Do not log the URL to prevent exposing provider-controlled data
        throw new Error(`OIDC ${name} must use HTTPS in production`);
      }
      return url;
    };

    parseAndValidateUrl(json.authorization_endpoint, "authorization_endpoint");
    parseAndValidateUrl(json.token_endpoint, "token_endpoint");
    parseAndValidateUrl(json.jwks_uri, "jwks_uri");

    const userInfoEndpoint =
      typeof json.userinfo_endpoint === "string" && json.userinfo_endpoint ? json.userinfo_endpoint : undefined;
    if (userInfoEndpoint) {
      parseAndValidateUrl(userInfoEndpoint, "userinfo_endpoint");
    }

    const doc: OidcDiscovery = {
      issuer: json.issuer,
      authorization_endpoint: json.authorization_endpoint,
      token_endpoint: json.token_endpoint,
      jwks_uri: json.jwks_uri,
      userinfo_endpoint: userInfoEndpoint,
      id_token_signing_alg_values_supported: signingAlgs,
    };

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
  algorithms: string[]; // Required, not optional - must come from validated discovery
}): Promise<OidcIdTokenClaims> {
  const jwks = jose.createRemoteJWKSet(new URL(opts.jwksUri));
  // Use only the algorithms from validated discovery (no fallback)
  const { payload } = await jose.jwtVerify(opts.idToken, jwks, {
    issuer: opts.issuer,
    audience: opts.clientId,
    algorithms: opts.algorithms,
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

  // Validate nonce
  if (payload.nonce !== opts.nonce) {
    throw new Error("OIDC id_token nonce mismatch");
  }

  // Validate iat is recent (within last 10 minutes)
  const now = Math.floor(Date.now() / 1000);
  const iat = payload.iat as number;
  if (iat > now + 60) {
    throw new Error("OIDC id_token iat is in the future");
  }
  if (now - iat > 600) {
    throw new Error("OIDC id_token iat is too old (>10 minutes)");
  }

  // Validate azp when aud is an array with multiple values
  const aud = payload.aud;
  if (Array.isArray(aud) && aud.length > 1) {
    if (!payload.azp || typeof payload.azp !== "string") {
      throw new Error("OIDC id_token with multiple audiences must have azp claim");
    }
    if (payload.azp !== opts.clientId) {
      throw new Error("OIDC id_token azp does not match client_id");
    }
  }

  // Runtime validate optional profile claims before returning
  if (payload.email !== undefined && typeof payload.email !== "string") {
    throw new Error("OIDC id_token email must be a string");
  }
  if (payload.email_verified !== undefined && typeof payload.email_verified !== "boolean") {
    throw new Error("OIDC id_token email_verified must be a boolean");
  }
  if (payload.name !== undefined && typeof payload.name !== "string") {
    throw new Error("OIDC id_token name must be a string");
  }
  if (payload.nickname !== undefined && typeof payload.nickname !== "string") {
    throw new Error("OIDC id_token nickname must be a string");
  }
  if (payload.preferred_username !== undefined && typeof payload.preferred_username !== "string") {
    throw new Error("OIDC id_token preferred_username must be a string");
  }
  if (payload.picture !== undefined && typeof payload.picture !== "string") {
    throw new Error("OIDC id_token picture must be a string");
  }

  return payload as OidcIdTokenClaims;
}

export async function fetchUserInfo(opts: {
  userInfoEndpoint: string;
  accessToken: string;
  expectedSub: string;
}): Promise<OidcUserInfoProfile> {
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

    // Return a narrow, explicitly constructed profile object (not the full JSON)
    // Only whitelist intended profile fields, never security claims like iss/aud/exp/iat
    return {
      sub: json.sub,
      email: json.email as string | undefined,
      email_verified: json.email_verified as boolean | undefined,
      name: json.name as string | undefined,
      nickname: json.nickname as string | undefined,
      preferred_username: json.preferred_username as string | undefined,
      picture: json.picture as string | undefined,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
