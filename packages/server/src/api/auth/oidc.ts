import { randomBytes } from "node:crypto";
import { oauthStartQuerySchema, safeRedirectPath } from "@first-tree/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { signTokensForUser } from "../../services/auth.js";
import { findOrCreateUserFromExternalAccount } from "../../services/auth-identity.js";
import { completeExternalAccountBootstrap, OAuthBootstrapError } from "../../services/oauth-bootstrap.js";
import {
  STATE_NONCE_COOKIE_NAME,
  STATE_NONCE_COOKIE_TTL_SECONDS,
  signOAuthState,
  verifyOAuthState,
} from "../../services/oauth-state.js";
import { exchangeOidcCode, fetchDiscovery, fetchUserInfo, generatePkce, verifyIdToken } from "../../services/oidc.js";
import { resolvePublicUrl } from "../../utils/public-url.js";
import { buildCookie, protectOAuthStateNonce, readOAuthStateNonce } from "./oauth-cookie.js";

const PKCE_COOKIE_NAME = "oidc_pkce";
const PKCE_COOKIE_TTL_SECONDS = 10 * 60;

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  app.get("/start", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (app.config.authMode !== "oidc-required" || !app.config.oidc) {
      return reply.status(404).send({ error: "OIDC is not enabled" });
    }

    const { next } = oauthStartQuerySchema.parse(request.query);
    const safeNext = safeRedirectPath(next ?? null);
    const oidcNonce = randomBytes(24).toString("base64url");
    const { codeVerifier, codeChallenge } = generatePkce();

    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, safeNext, {
      provider: "oidc",
      intent: "sign-in",
      oidcNonce,
    });

    let discovery: Awaited<ReturnType<typeof fetchDiscovery>>;
    try {
      discovery = await fetchDiscovery(app.config.oidc.issuer);
    } catch (error) {
      // Do not log provider-controlled error details to prevent log injection
      app.log.error(
        { event: "oauth.discovery_failed", provider: "oidc" },
        "OIDC discovery failed at start",
      );
      // Redirect through /auth/complete with bounded error instead of returning raw 503 JSON
      return redirectError(reply, "provider-unavailable", safeNext);
    }

    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/oidc/callback`;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: app.config.oidc.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state: token,
      nonce: oidcNonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    reply.header("Set-Cookie", stateCookie(nonce, STATE_NONCE_COOKIE_TTL_SECONDS, app.config.secrets.encryptionKey));
    // Bind PKCE verifier to state nonce to prevent CSRF
    const pkcePayload = JSON.stringify({ nonce, verifier: codeVerifier });
    reply.header("Set-Cookie", pkceCookie(pkcePayload, PKCE_COOKIE_TTL_SECONDS, app.config.secrets.encryptionKey));

    app.log.info({ event: "oauth.start", provider: "oidc", intent: "sign-in" }, "OIDC flow started");
    return reply.redirect(`${discovery.authorization_endpoint}?${params.toString()}`, 302);
  });

  app.get("/callback", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (app.config.authMode !== "oidc-required" || !app.config.oidc) {
      return reply.status(404).send({ error: "OIDC is not enabled" });
    }

    const query = request.query as Record<string, string>;
    if (query.error) {
      // Do not log provider-controlled error value to prevent log injection
      app.log.warn({ event: "oauth.callback_rejected", provider: "oidc" }, "OIDC provider error");
      clearOidcCookies(reply, app.config.secrets.encryptionKey);
      return redirectError(reply, "provider-exchange-failed");
    }

    const { code, state } = query;
    if (!code || !state) {
      clearOidcCookies(reply, app.config.secrets.encryptionKey);
      return redirectError(reply, "provider-exchange-failed");
    }

    const cookieNonce = readOAuthStateNonce(
      request.headers.cookie,
      STATE_NONCE_COOKIE_NAME,
      app.config.secrets.encryptionKey,
    );

    let verified: Awaited<ReturnType<typeof verifyOAuthState>>;
    try {
      verified = await verifyOAuthState(app.config.secrets.jwtSecret, state, cookieNonce);
    } catch (error) {
      app.log.warn({ err: error, event: "oauth.callback_rejected", provider: "oidc" }, "OAuth state rejected");
      clearOidcCookies(reply, app.config.secrets.encryptionKey);
      return redirectError(reply, "state-expired");
    }

    if (verified.provider !== "oidc") {
      clearOidcCookies(reply, app.config.secrets.encryptionKey);
      return redirectError(reply, "state-expired");
    }

    // Read and validate PKCE cookie (bound to state nonce)
    const pkceCookieValue = readOAuthStateNonce(
      request.headers.cookie,
      PKCE_COOKIE_NAME,
      app.config.secrets.encryptionKey,
    );
    if (!pkceCookieValue) {
      clearOidcCookies(reply, app.config.secrets.encryptionKey);
      return redirectError(reply, "state-expired", verified.next);
    }

    let codeVerifier: string;
    try {
      const parsed = JSON.parse(pkceCookieValue);
      // Runtime validation of PKCE payload
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("PKCE payload is not an object");
      }
      if (typeof parsed.nonce !== "string" || !parsed.nonce) {
        throw new Error("PKCE payload missing nonce");
      }
      if (typeof parsed.verifier !== "string" || !parsed.verifier) {
        throw new Error("PKCE payload missing verifier");
      }
      const pkcePayload = parsed as { nonce: string; verifier: string };
      if (pkcePayload.nonce !== cookieNonce) {
        app.log.warn({ event: "oidc.pkce_nonce_mismatch" }, "PKCE cookie nonce does not match state nonce");
        clearOidcCookies(reply, app.config.secrets.encryptionKey);
        return redirectError(reply, "state-expired", verified.next);
      }
      codeVerifier = pkcePayload.verifier;
    } catch (error) {
      // Do not log cookie parse errors to prevent exposing malformed data
      app.log.warn({ event: "oidc.pkce_parse_failed" }, "Failed to parse PKCE cookie");
      clearOidcCookies(reply, app.config.secrets.encryptionKey);
      return redirectError(reply, "state-expired", verified.next);
    }

    // Clear cookies
    reply.header("Set-Cookie", stateCookie("", 0, app.config.secrets.encryptionKey));
    reply.header("Set-Cookie", pkceCookie("", 0, app.config.secrets.encryptionKey));

    let discovery: Awaited<ReturnType<typeof fetchDiscovery>>;
    try {
      discovery = await fetchDiscovery(app.config.oidc.issuer);
    } catch (error) {
      // Do not log provider-controlled error details
      app.log.error(
        { event: "oidc.discovery_failed", provider: "oidc" },
        "OIDC discovery failed at callback",
      );
      return redirectError(reply, "provider-exchange-failed", verified.next);
    }

    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/oidc/callback`;

    let tokenSet: Awaited<ReturnType<typeof exchangeOidcCode>>;
    try {
      tokenSet = await exchangeOidcCode({
        tokenEndpoint: discovery.token_endpoint,
        code,
        redirectUri,
        clientId: app.config.oidc.clientId,
        clientSecret: app.config.oidc.clientSecret,
        codeVerifier,
      });
    } catch (error) {
      // Do not log provider-controlled token exchange errors
      app.log.error(
        { event: "oauth.token_exchange_failed", provider: "oidc" },
        "OIDC token exchange failed",
      );
      return redirectError(reply, "provider-exchange-failed", verified.next);
    }

    let claims: Awaited<ReturnType<typeof verifyIdToken>>;
    try {
      claims = await verifyIdToken({
        idToken: tokenSet.id_token,
        jwksUri: discovery.jwks_uri,
        issuer: app.config.oidc.issuer,
        clientId: app.config.oidc.clientId,
        nonce: verified.oidcNonce!,
        algorithms: discovery.id_token_signing_alg_values_supported,
      });
    } catch (error) {
      // Do not log provider-controlled ID token verification errors
      app.log.error(
        { event: "oauth.id_token_invalid", provider: "oidc" },
        "OIDC id_token verification failed",
      );
      return redirectError(reply, "provider-exchange-failed", verified.next);
    }

    // Fetch UserInfo to supplement profile data missing from id_token.
    // email/email_verified must be tracked together from the same source to
    // avoid mixing a verified flag from id_token with an email from userInfo.
    if (discovery.userinfo_endpoint) {
      try {
        const userInfo = await fetchUserInfo({
          userInfoEndpoint: discovery.userinfo_endpoint,
          accessToken: tokenSet.access_token,
          expectedSub: claims.sub,
        });
        // Whitelist only profile fields from UserInfo; retain identity and security claims from ID token.
        // Email and email_verified must be tracked together from the same source.
        const emailSource =
          userInfo.email !== undefined
            ? { email: userInfo.email, email_verified: userInfo.email_verified }
            : { email: claims.email, email_verified: claims.email_verified };
        // Only merge whitelisted profile fields, not security claims (iss, aud, exp, iat, nonce, azp)
        claims = {
          ...claims,
          ...emailSource,
          // Profile fields that can be supplemented from UserInfo
          name: userInfo.name ?? claims.name,
          nickname: userInfo.nickname ?? claims.nickname,
          preferred_username: userInfo.preferred_username ?? claims.preferred_username,
          picture: userInfo.picture ?? claims.picture,
        };
      } catch (error) {
        app.log.error({ err: error, event: "oidc.userinfo_failed", provider: "oidc" }, "OIDC userinfo failed");
        return redirectError(reply, "provider-exchange-failed", verified.next);
      }
    }

    // Only use email if email_verified is explicitly true
    const verifiedEmail = claims.email && claims.email_verified === true ? claims.email : null;

    const identifier = JSON.stringify([app.config.oidc.issuer, claims.sub]);
    const account = await findOrCreateUserFromExternalAccount(app.db, {
      provider: "oidc",
      subject: identifier,
      usernameCandidates: [
        claims.preferred_username,
        claims.nickname,
        verifiedEmail?.split("@")[0],
        claims.name,
        claims.sub,
      ].filter((v): v is string => Boolean(v)),
      displayName: claims.name ?? claims.nickname ?? claims.preferred_username ?? null,
      email: verifiedEmail,
      avatarUrl: claims.picture ?? null,
      metadata: { issuer: claims.iss, sub: claims.sub },
    });

    let bootstrap: Awaited<ReturnType<typeof completeExternalAccountBootstrap>>;
    try {
      bootstrap = await completeExternalAccountBootstrap(app.db, account, {
        next: verified.next,
        allowedOrganizationId: app.config.access?.allowedOrganizationId ?? null,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? "",
      });
    } catch (error) {
      if (error instanceof OAuthBootstrapError) return redirectError(reply, error.code, verified.next);
      throw error;
    }

    const tokens = await signTokensForUser(app.config.secrets.jwtSecret, account.userId, app.config.auth);
    const fragment = new URLSearchParams({
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      next: bootstrap.next,
      accountCreated: account.created ? "1" : "0",
      callbackIntent: "sign-in",
      provider: "oidc",
      org: bootstrap.organizationId,
      ...(bootstrap.orgPinned ? { orgPinned: "1" } : {}),
    }).toString();

    app.log.info(
      {
        event: account.created ? "oauth.account_created" : "oauth.account_reused",
        provider: "oidc",
        userId: account.userId,
      },
      "OIDC sign-in completed",
    );
    return reply.redirect(`/auth/complete#${fragment}`, 302);
  });
}

function stateCookie(value: string, maxAge: number, encryptionKey: string): string {
  return buildCookie({
    name: STATE_NONCE_COOKIE_NAME,
    value: maxAge > 0 ? protectOAuthStateNonce(value, encryptionKey) : "",
    maxAge,
    secure: process.env.NODE_ENV === "production",
  });
}

function pkceCookie(value: string, maxAge: number, encryptionKey: string): string {
  return buildCookie({
    name: PKCE_COOKIE_NAME,
    value: maxAge > 0 ? protectOAuthStateNonce(value, encryptionKey) : "",
    maxAge,
    secure: process.env.NODE_ENV === "production",
  });
}

function clearOidcCookies(reply: FastifyReply, encryptionKey: string): void {
  reply.header("Set-Cookie", stateCookie("", 0, encryptionKey));
  reply.header("Set-Cookie", pkceCookie("", 0, encryptionKey));
}

function redirectError(reply: FastifyReply, code: string, next?: string | null) {
  const fragment = new URLSearchParams({
    error: code,
    next: next ?? "/",
    callbackIntent: "sign-in",
    provider: "oidc",
  }).toString();
  return reply.redirect(`/auth/complete#${fragment}`, 302);
}
