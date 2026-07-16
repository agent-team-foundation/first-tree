import { randomBytes } from "node:crypto";
import {
  googleCallbackQuerySchema,
  googleExternalProfile,
  oauthStartQuerySchema,
  safeRedirectPath,
} from "@first-tree/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { signTokensForUser } from "../../services/auth.js";
import {
  findOrCreateUserFromExternalAccount,
  IdentityConflictError,
  IdentityMismatchError,
  LastIdentityError,
  linkExternalIdentity,
  unlinkExternalIdentity,
} from "../../services/auth-identity.js";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode } from "../../services/google-oauth.js";
import { completeExternalAccountBootstrap, OAuthBootstrapError } from "../../services/oauth-bootstrap.js";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_MAX_AGE_S,
  signOAuthState,
  verifyOAuthState,
} from "../../services/oauth-state.js";
import { resolvePublicUrl } from "../../utils/public-url.js";
import { buildCookie, protectOAuthStateNonce, readOAuthStateNonce } from "./oauth-cookie.js";

export async function googleOauthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/start", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const config = app.config.oauth?.google;
    if (!config) return reply.status(503).send({ code: "provider-not-configured", error: "Google is not configured" });
    const { next } = oauthStartQuerySchema.parse(request.query);
    const oidcNonce = randomBytes(24).toString("base64url");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, safeRedirectPath(next ?? null), {
      provider: "google",
      intent: "sign-in",
      oidcNonce,
    });
    // Encrypt the short-lived CSRF nonce before placing it in the browser
    // cookie; the callback also accepts legacy plaintext nonce cookies.
    // The value is a nonce-only CSRF token, not an access credential or
    // provider identity; it is short-lived, HttpOnly, SameSite=Lax, and Secure
    // in production. CodeQL otherwise treats the Set-Cookie sink as storage.
    // codeql[js/clear-text-storage-sensitive-data]
    reply.header("Set-Cookie", stateCookie(nonce, OAUTH_STATE_COOKIE_MAX_AGE_S, app.config.secrets.encryptionKey));
    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/google/callback`;
    app.log.info({ event: "oauth.start", provider: "google", intent: "sign-in" }, "OAuth flow started");
    return reply.redirect(
      buildGoogleAuthorizeUrl({ clientId: config.clientId, redirectUri, state: token, nonce: oidcNonce }),
      302,
    );
  });

  app.get("/callback", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const config = app.config.oauth?.google;
    if (!config) return redirectError(reply, "provider-not-configured");
    const { code, state, error: providerError } = googleCallbackQuerySchema.parse(request.query);
    if (providerError) return redirectError(reply, "provider-exchange-failed");
    if (!code || !state) return redirectError(reply, "provider-exchange-failed");
    const cookieNonce = readOAuthStateNonce(
      request.headers.cookie,
      OAUTH_STATE_COOKIE,
      app.config.secrets.encryptionKey,
    );
    let verified: Awaited<ReturnType<typeof verifyOAuthState>>;
    try {
      verified = await verifyOAuthState(app.config.secrets.jwtSecret, state, cookieNonce);
    } catch (error) {
      app.log.warn({ err: error, event: "oauth.callback_rejected", provider: "google" }, "OAuth state rejected");
      return redirectError(reply, "state-expired");
    }
    if (verified.provider && verified.provider !== "google") {
      app.log.warn({ event: "oauth.callback_rejected", provider: "google", reason: "provider-mismatch" });
      return redirectError(reply, "state-expired", verified.next);
    }
    // Clear the single-use OAuth state cookie after validating it.
    // codeql[js/clear-text-storage-sensitive-data]
    reply.header("Set-Cookie", stateCookie("", 0, app.config.secrets.encryptionKey));
    if (!verified.oidcNonce) return redirectError(reply, "state-expired");

    let profile: ReturnType<typeof googleExternalProfile>;
    try {
      const claims = await exchangeGoogleCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri: `${resolvePublicUrl(app, request)}/api/v1/auth/google/callback`,
        nonce: verified.oidcNonce,
      });
      profile = googleExternalProfile(claims);
    } catch (error) {
      app.log.warn({ err: error, event: "oauth.exchange_failed", provider: "google" }, "Google OAuth exchange failed");
      return redirectError(reply, "provider-exchange-failed", verified.next);
    }

    if (verified.intent === "link" || verified.intent === "unlink") {
      if (!verified.userId) return redirectError(reply, "state-expired", "/user-settings");
      try {
        if (verified.intent === "link") {
          await linkExternalIdentity(app.db, verified.userId, profile);
          app.log.info({ event: "identity.linked", provider: "google", userId: verified.userId }, "Identity linked");
          return reply.redirect("/user-settings?connection=google-linked", 302);
        }
        await unlinkExternalIdentity(
          app.db,
          verified.userId,
          "google",
          profile.subject,
          {
            google: Boolean(app.config.oauth?.google),
            github: Boolean(app.config.oauth?.githubApp),
          },
          verified.targetIdentityId ?? "",
        );
        app.log.info({ event: "identity.unlinked", provider: "google", userId: verified.userId }, "Identity unlinked");
        return reply.redirect("/user-settings?connection=google-unlinked", 302);
      } catch (error) {
        if (error instanceof IdentityConflictError)
          return reply.redirect("/user-settings?error=identity-conflict", 302);
        if (error instanceof IdentityMismatchError)
          return reply.redirect("/user-settings?error=identity-mismatch", 302);
        if (error instanceof LastIdentityError) return reply.redirect("/user-settings?error=last-provider", 302);
        throw error;
      }
    }

    return completeGoogleSignIn(app, request, reply, profile, verified.next);
  });
}

async function completeGoogleSignIn(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  profile: ReturnType<typeof googleExternalProfile>,
  next: string,
) {
  const account = await findOrCreateUserFromExternalAccount(app.db, profile);
  let bootstrap: Awaited<ReturnType<typeof completeExternalAccountBootstrap>>;
  try {
    bootstrap = await completeExternalAccountBootstrap(app.db, account, {
      next,
      allowedOrganizationId: app.config.access?.allowedOrganizationId ?? null,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
  } catch (error) {
    if (error instanceof OAuthBootstrapError) return redirectError(reply, error.code, next);
    throw error;
  }
  if (bootstrap.teamCreated) {
    app.log.info(
      {
        event: "onboarding.team_created",
        provider: "google",
        userId: account.userId,
        organizationId: bootstrap.organizationId,
        source: "oauth-bootstrap",
      },
      "onboarding funnel: team auto-created at OAuth bootstrap",
    );
  }
  const tokens = await signTokensForUser(app.config.secrets.jwtSecret, account.userId, app.config.auth);
  const fragment = new URLSearchParams({
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    next: bootstrap.next,
    joinPath: bootstrap.joinPath,
    org: bootstrap.organizationId,
    ...(bootstrap.orgPinned ? { orgPinned: "1" } : {}),
  }).toString();
  app.log.info(
    {
      event: account.created ? "oauth.account_created" : "oauth.account_reused",
      provider: "google",
      userId: account.userId,
    },
    "OAuth sign-in completed",
  );
  return reply.redirect(`/auth/complete#${fragment}`, 302);
}

function stateCookie(value: string, maxAge: number, encryptionKey: string): string {
  return buildCookie({
    name: OAUTH_STATE_COOKIE,
    value: maxAge > 0 ? protectOAuthStateNonce(value, encryptionKey) : "",
    maxAge,
    secure: process.env.NODE_ENV === "production",
  });
}

function redirectError(reply: FastifyReply, code: string, next = "/") {
  const fragment = new URLSearchParams({ error: code, next }).toString();
  return reply.redirect(`/auth/complete#${fragment}`, 302);
}
