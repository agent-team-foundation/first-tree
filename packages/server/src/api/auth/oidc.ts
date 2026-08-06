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
    const oidcNonce = randomBytes(24).toString("base64url");
    const { codeVerifier, codeChallenge } = generatePkce();

    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, safeRedirectPath(next ?? null), {
      provider: "oidc",
      intent: "sign-in",
      oidcNonce,
    });

    const discovery = await fetchDiscovery(app.config.oidc.issuer);
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
    reply.header("Set-Cookie", pkceCookie(codeVerifier, PKCE_COOKIE_TTL_SECONDS, app.config.secrets.encryptionKey));

    app.log.info({ event: "oauth.start", provider: "oidc", intent: "sign-in" }, "OIDC flow started");
    return reply.redirect(`${discovery.authorization_endpoint}?${params.toString()}`, 302);
  });

  app.get("/callback", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (app.config.authMode !== "oidc-required" || !app.config.oidc) {
      return reply.status(404).send({ error: "OIDC is not enabled" });
    }

    const query = request.query as Record<string, string>;
    if (query.error) {
      app.log.warn({ event: "oauth.callback_rejected", provider: "oidc", error: query.error }, "OIDC provider error");
      return redirectError(reply, "provider-exchange-failed");
    }

    const { code, state } = query;
    if (!code || !state) return redirectError(reply, "provider-exchange-failed");

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
      return redirectError(reply, "state-expired");
    }

    if (verified.provider !== "oidc") return redirectError(reply, "state-expired");

    const codeVerifier = readOAuthStateNonce(
      request.headers.cookie,
      PKCE_COOKIE_NAME,
      app.config.secrets.encryptionKey,
    );
    if (!codeVerifier) return redirectError(reply, "state-expired");

    // Clear cookies
    reply.header("Set-Cookie", stateCookie("", 0, app.config.secrets.encryptionKey));
    reply.header("Set-Cookie", pkceCookie("", 0, app.config.secrets.encryptionKey));

    const discovery = await fetchDiscovery(app.config.oidc.issuer);
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
      app.log.error(
        { err: error, event: "oauth.token_exchange_failed", provider: "oidc" },
        "OIDC token exchange failed",
      );
      return redirectError(reply, "provider-exchange-failed");
    }

    let claims: Awaited<ReturnType<typeof verifyIdToken>>;
    try {
      claims = await verifyIdToken({
        idToken: tokenSet.id_token,
        jwksUri: discovery.jwks_uri,
        issuer: app.config.oidc.issuer,
        clientId: app.config.oidc.clientId,
        nonce: verified.oidcNonce!,
      });
    } catch (error) {
      app.log.error(
        { err: error, event: "oauth.id_token_invalid", provider: "oidc" },
        "OIDC id_token verification failed",
      );
      return redirectError(reply, "provider-exchange-failed");
    }

    // Fetch UserInfo to supplement profile data missing from id_token
    if (discovery.userinfo_endpoint) {
      try {
        const userInfo = await fetchUserInfo({
          userInfoEndpoint: discovery.userinfo_endpoint,
          accessToken: tokenSet.access_token,
          expectedSub: claims.sub,
        });
        // Merge userInfo into claims (userInfo takes precedence for profile fields)
        claims = { ...claims, ...userInfo };
      } catch (error) {
        app.log.warn({ err: error, event: "oidc.userinfo_failed", provider: "oidc" }, "OIDC userinfo fetch failed");
        // Non-fatal: continue with id_token claims only
      }
    }

    const identifier = JSON.stringify([app.config.oidc.issuer, claims.sub]);
    const account = await findOrCreateUserFromExternalAccount(app.db, {
      provider: "oidc",
      subject: identifier,
      usernameCandidates: [
        claims.preferred_username,
        claims.nickname,
        claims.email?.split("@")[0],
        claims.name,
        claims.sub,
      ].filter((v): v is string => Boolean(v)),
      displayName: claims.name ?? claims.nickname ?? claims.preferred_username ?? null,
      email: claims.email ?? null,
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
      if (error instanceof OAuthBootstrapError) return redirectError(reply, error.code);
      throw error;
    }

    const tokens = await signTokensForUser(app.config.secrets.jwtSecret, account.userId, app.config.auth);
    const fragment = new URLSearchParams({
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      next: bootstrap.next,
      accountCreated: account.created ? "1" : "0",
      callbackIntent: "sign-in",
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

function redirectError(reply: FastifyReply, code: string) {
  const fragment = new URLSearchParams({ error: code, next: "/", callbackIntent: "sign-in" }).toString();
  return reply.redirect(`/auth/complete#${fragment}`, 302);
}
