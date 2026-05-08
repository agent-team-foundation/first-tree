import {
  githubCallbackQuerySchema,
  githubDevCallbackQuerySchema,
  githubStartQuerySchema,
  safeRedirectPath,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { signTokensForUser } from "../../services/auth.js";
import { findOrCreateUserFromGithub, type GithubProfile } from "../../services/auth-identity.js";
import { encryptValue } from "../../services/crypto.js";
import { exchangeCodeForProfile } from "../../services/github-oauth.js";
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

/**
 * GitHub OAuth surface. All routes are public (no member JWT required).
 *
 * Routes:
 *   - GET /auth/github/start         — sign state JWT + cookie + 302 to GitHub
 *   - GET /auth/github/callback      — verify state + exchange code → fragment
 *   - GET /auth/github/dev-callback  — dev-only stub (no GitHub round-trip)
 */
export async function githubOauthRoutes(app: FastifyInstance): Promise<void> {
  // Half-configured guard — gate `dev-callback` on a real OAuth client when
  // the operator opted into it. Half-config (clientId without clientSecret
  // or vice versa) is rejected by the config singleton; here we just refuse
  // to mount the routes with a clear log line if neither side is wired up.
  const oauthCfg = app.config.oauth?.github;
  if (!oauthCfg) {
    app.log.info(
      "GitHub OAuth not configured — /auth/github/start will return 503. Set FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_ID/_SECRET to enable.",
    );
  }

  // Rate-limit `/start` more tightly than the global default — minting state
  // tokens is cheap server-side but a flood inflates the cookie+JWT budget
  // a single browser carries, so cap at 20/min/IP.
  app.get("/start", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { next } = githubStartQuerySchema.parse(request.query);
    const safeNext = safeRedirectPath(next ?? null);
    if (!oauthCfg) {
      return reply.status(503).send({ error: "GitHub OAuth is not configured on this hub" });
    }

    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, safeNext);
    const isProd = process.env.NODE_ENV === "production";
    reply.header(
      "Set-Cookie",
      buildCookie({
        name: OAUTH_STATE_COOKIE,
        value: nonce,
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_S,
        secure: isProd,
      }),
    );

    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/github/callback`;
    const params = new URLSearchParams({
      client_id: oauthCfg.clientId,
      redirect_uri: redirectUri,
      state: token,
      // `repo` scope is required by the Step 2 repo picker
      // (docs/new-user-onboarding-design.md §6.3 / O-1). We grant it at
      // login rather than on-demand mid-onboarding so the picker works
      // immediately when the user reaches Step 2 without a second redirect.
      scope: "read:user user:email repo",
      allow_signup: "true",
    });
    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
  });

  app.get("/callback", async (request, reply) => {
    if (!oauthCfg) {
      return reply.status(503).send({ error: "GitHub OAuth is not configured on this hub" });
    }
    const { code, state } = githubCallbackQuerySchema.parse(request.query);
    const cookieNonce = parseCookieHeader(request.headers.cookie, OAUTH_STATE_COOKIE);

    let next: string;
    try {
      const verified = await verifyOAuthState(app.config.secrets.jwtSecret, state, cookieNonce);
      next = verified.next;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "OAuth state rejected";
      return reply.status(401).send({ error: msg });
    }

    // Clear the state cookie even on success — it's single-use.
    reply.header(
      "Set-Cookie",
      buildCookie({
        name: OAUTH_STATE_COOKIE,
        value: "",
        maxAge: 0,
        secure: process.env.NODE_ENV === "production",
      }),
    );

    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/github/callback`;
    let profile: GithubProfile;
    let accessToken: string;
    try {
      const result = await exchangeCodeForProfile(
        { clientId: oauthCfg.clientId, clientSecret: oauthCfg.clientSecret },
        code,
        redirectUri,
      );
      profile = result.profile;
      accessToken = result.accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "GitHub exchange failed";
      app.log.warn({ err }, "github oauth code exchange failed");
      return reply.status(401).send({ error: msg });
    }

    return completeOauthFlow(app, request, reply, profile, next, accessToken);
  });

  app.get("/dev-callback", async (request, reply) => {
    // dev-callback mints a stub GitHub identity without round-tripping to
    // github.com. Always disabled in production — there's no flag to flip,
    // so a misconfigured prod deploy can never accidentally expose it.
    // In any non-production environment it's enabled unconditionally so dev
    // can sign in with one click without standing up a real OAuth client.
    if (process.env.NODE_ENV === "production") {
      return reply.status(404).send({ error: "Not found" });
    }
    const params = githubDevCallbackQuerySchema.parse(request.query);
    const next = safeRedirectPath(params.next ?? null);

    const profile: GithubProfile = {
      githubId: params.githubId,
      login: params.login,
      email: params.email ?? null,
      displayName: params.displayName ?? params.login,
      avatarUrl: null,
    };
    return completeOauthFlow(app, request, reply, profile, next, null);
  });
}

async function completeOauthFlow(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  profile: GithubProfile,
  next: string,
  /**
   * Raw GitHub OAuth access token. Persisted (encrypted) so the Step 2
   * repo picker can call GitHub APIs without a second OAuth round-trip.
   * `null` for `dev-callback` (no real GitHub round-trip happened).
   */
  rawAccessToken: string | null,
) {
  const encryptedAccessToken = rawAccessToken
    ? encryptValue(rawAccessToken, app.config.secrets.encryptionKey)
    : undefined;
  const { userId } = await findOrCreateUserFromGithub(app.db, profile, { encryptedAccessToken });

  // Track which signup path the user took. Surfaced to the SPA via the
  // post-OAuth fragment so the onboarding modal can pick context-aware copy.
  // - "invite": user redeemed an invite token, joined an existing org
  // - "solo":   first-time user, fresh org auto-provisioned
  // - "returning": existing user signing back in
  let joinPath: "invite" | "solo" | "returning" = "returning";

  // If `next` is an /invite/<token> path, join that org instead of
  // auto-provisioning. Invite paths look like `/invite/abc123`.
  const inviteMatch = /^\/invite\/([^/?#]+)/.exec(next);
  let resolved = false;

  if (inviteMatch?.[1]) {
    const token = inviteMatch[1];
    const inv = await findActiveByToken(app.db, token);
    if (!inv) {
      return reply.status(404).send({ error: "Invitation not found or no longer valid" });
    }
    await ensureMembership(app.db, {
      userId,
      organizationId: inv.organizationId,
      role: inv.role === "admin" ? "admin" : "member",
      displayName: profile.displayName?.trim() || profile.login,
      username: profile.login,
    });
    await recordRedemption(app.db, {
      invitationId: inv.id,
      userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    joinPath = "invite";
    resolved = true;
    // Drop the now-consumed invite path; land on the team dashboard so the
    // onboarding modal can layer on top.
    next = "/";
  } else {
    const primary = await pickPrimaryMembership(app.db, userId);
    if (primary) {
      resolved = true;
      // joinPath stays "returning"; preserve caller's original `next` intent.
    } else {
      const personal = await createPersonalTeam(app.db, {
        userId,
        loginSeed: profile.login,
        // Per docs/new-user-onboarding-design.md §5.5, default team name is
        // `${login}'s team` — reads as a collective space, matches Linear's
        // convention. The user can rename in Step 1 of onboarding.
        teamDisplayName: `${profile.login}'s team`,
        userDisplayName: profile.displayName?.trim() || profile.login,
      });
      joinPath = "solo";
      resolved = true;
      next = "/";
      // Onboarding funnel: structured log marker. Picked up by logfire/otel
      // pipelines via `event: "onboarding.team_created"` for funnel views.
      app.log.info(
        {
          event: "onboarding.team_created",
          userId,
          organizationId: personal.organizationId,
          source: "oauth-bootstrap",
        },
        "onboarding funnel: team auto-created at OAuth bootstrap",
      );
    }
  }

  if (!resolved) {
    return reply.status(500).send({ error: "Failed to resolve membership" });
  }

  const tokens = await signTokensForUser(app.config.secrets.jwtSecret, userId, app.config.auth);

  const fragment = new URLSearchParams({
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    next,
    joinPath,
  }).toString();
  return reply.redirect(`/auth/github/complete#${fragment}`, 302);
}
