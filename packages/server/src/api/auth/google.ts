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
import { findActiveByToken, recordRedemption } from "../../services/invitation.js";
import { createPersonalTeam, ensureMembership, pickPrimaryMembership } from "../../services/membership.js";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_MAX_AGE_S,
  signOAuthState,
  verifyOAuthState,
} from "../../services/oauth-state.js";
import { resolvePublicUrl } from "../../utils/public-url.js";
import { buildCookie, parseCookieHeader } from "./oauth-cookie.js";

export async function googleOauthRoutes(app: FastifyInstance): Promise<void> {
  // OAuth routes use the global actor-aware limiter registered in app.ts.
  // codeql[js/missing-rate-limiting]
  app.get("/start", async (request, reply) => {
    const config = app.config.oauth?.google;
    if (!config) return reply.status(503).send({ code: "provider-not-configured", error: "Google is not configured" });
    const { next } = oauthStartQuerySchema.parse(request.query);
    const oidcNonce = randomBytes(24).toString("base64url");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, safeRedirectPath(next ?? null), {
      provider: "google",
      intent: "sign-in",
      oidcNonce,
    });
    // The cookie stores only a random, short-lived CSRF nonce, not a token or
    // provider identity. It is HttpOnly, SameSite=Lax, and Secure in prod.
    // codeql[js/clear-text-storage-sensitive-data]
    reply.header("Set-Cookie", stateCookie(nonce));
    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/google/callback`;
    app.log.info({ event: "oauth.start", provider: "google", intent: "sign-in" }, "OAuth flow started");
    return reply.redirect(
      buildGoogleAuthorizeUrl({ clientId: config.clientId, redirectUri, state: token, nonce: oidcNonce }),
      302,
    );
  });

  // OAuth routes use the global actor-aware limiter registered in app.ts.
  // codeql[js/missing-rate-limiting]
  app.get("/callback", async (request, reply) => {
    const config = app.config.oauth?.google;
    if (!config) return redirectError(reply, "provider-not-configured");
    const { code, state, error: providerError } = googleCallbackQuerySchema.parse(request.query);
    if (providerError) return redirectError(reply, "provider-exchange-failed");
    if (!code || !state) return redirectError(reply, "provider-exchange-failed");
    const cookieNonce = parseCookieHeader(request.headers.cookie, OAUTH_STATE_COOKIE);
    let verified: Awaited<ReturnType<typeof verifyOAuthState>>;
    try {
      verified = await verifyOAuthState(app.config.secrets.jwtSecret, state, cookieNonce);
    } catch (error) {
      app.log.warn({ err: error, event: "oauth.callback_rejected", provider: "google" }, "OAuth state rejected");
      return redirectError(reply, "state-expired");
    }
    // This deletion header clears the same nonce-only cookie.
    // codeql[js/clear-text-storage-sensitive-data]
    reply.header("Set-Cookie", stateCookie("", 0));
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
        await unlinkExternalIdentity(app.db, verified.userId, "google", profile.subject);
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
  const allowedOrganizationId = app.config.access?.allowedOrganizationId ?? null;
  let joinPath: "invite" | "solo" | "returning" = "returning";
  let organizationId: string | null = null;
  let orgPinned = false;
  const inviteMatch = /^\/invite\/([^/?#]+)/.exec(next);

  if (inviteMatch?.[1]) {
    const invitation = await findActiveByToken(app.db, inviteMatch[1]);
    if (!invitation) return redirectError(reply, "invite-invalid");
    if (allowedOrganizationId && invitation.organizationId !== allowedOrganizationId) {
      return redirectError(reply, "invite-not-allowed");
    }
    await ensureMembership(app.db, {
      userId: account.userId,
      organizationId: invitation.organizationId,
      role: invitation.role === "admin" ? "admin" : "member",
      displayName: account.displayName,
      username: account.username,
    });
    await recordRedemption(app.db, {
      invitationId: invitation.id,
      userId: account.userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    organizationId = invitation.organizationId;
    orgPinned = true;
    joinPath = "invite";
    next = "/";
  } else {
    const primary = await pickPrimaryMembership(app.db, account.userId);
    if (primary) organizationId = primary.organizationId;
    else {
      if (allowedOrganizationId) return redirectError(reply, "invite-required");
      const team = await createPersonalTeam(app.db, {
        userId: account.userId,
        loginSeed: account.username,
        teamDisplayName: personalTeamDisplayName(account.displayName),
        userDisplayName: account.displayName,
      });
      organizationId = team.organizationId;
      orgPinned = true;
      joinPath = "solo";
      next = "/";
    }
  }

  if (!organizationId) return redirectError(reply, "membership-unresolved");
  const tokens = await signTokensForUser(app.config.secrets.jwtSecret, account.userId, app.config.auth);
  const fragment = new URLSearchParams({
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    next,
    joinPath,
    org: organizationId,
    ...(orgPinned ? { orgPinned: "1" } : {}),
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

function stateCookie(value: string, maxAge = OAUTH_STATE_COOKIE_MAX_AGE_S): string {
  return buildCookie({ name: OAUTH_STATE_COOKIE, value, maxAge, secure: process.env.NODE_ENV === "production" });
}

function redirectError(reply: FastifyReply, code: string, next = "/") {
  const fragment = new URLSearchParams({ error: code, next }).toString();
  return reply.redirect(`/auth/complete#${fragment}`, 302);
}

function personalTeamDisplayName(displayName: string): string {
  return `${displayName.slice(0, 193)}'s team`;
}
