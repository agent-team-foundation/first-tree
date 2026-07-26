import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  nonce: string;
}): Promise<{
  sub: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  picture: string | null;
}> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("id_token" in body) || typeof body.id_token !== "string") {
    throw new Error("Google token response did not include an ID token");
  }
  const { payload } = await jwtVerify(body.id_token, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: input.clientId,
  });
  if (payload.nonce !== input.nonce) throw new Error("Google ID token nonce mismatch");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("Google ID token missing subject");
  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : null,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}
