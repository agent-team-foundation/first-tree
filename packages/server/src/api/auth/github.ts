import {
  githubCallbackQuerySchema,
  githubDevCallbackQuerySchema,
  githubStartQuerySchema,
  safeRedirectPath,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { signTokensForUser } from "../../services/auth.js";
import {
  findOrCreateUserFromGithub,
  type GithubProfile,
  type GithubTokenBundle,
} from "../../services/auth-identity.js";
import { encryptValue } from "../../services/crypto.js";
import { buildAppAuthorizeUrl, exchangeCodeForAppUserProfile } from "../../services/github-app.js";
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
 * GitHub sign-in surface. All routes are public (no member JWT required).
 *
 * Two coexisting flows during the App migration window:
 *
 *   App flow (preferred, enabled when `oauth.githubApp` is configured) —
 *   user gets the combined "OAuth + install" dialog on first sign-in (D1),
 *   returns with `code + state + installation_id`. Token bundle persisted
 *   is the App user-to-server pair (access + refresh + expiries, ~8h /
 *   ~6mo TTLs).
 *
 *   Legacy OAuth flow (kept for back-compat, enabled when only
 *   `oauth.github` is configured) — the pre-App SaaS sign-in path. Token
 *   persisted is a single never-expiring OAuth token. D3 cutover (later
 *   commit in this PR) deletes this path outright.
 *
 *   Dev-callback — bypasses GitHub entirely; available in non-production.
 *
 * Routes:
 *   - GET /auth/github/start         — sign state JWT + cookie + 302 to GitHub
 *   - GET /auth/github/callback      — verify state + exchange code → fragment
 *   - GET /auth/github/dev-callback  — dev-only stub (no GitHub round-trip)
 */
export async function githubOauthRoutes(app: FastifyInstance): Promise<void> {
  const oauthCfg = app.config.oauth?.github;
  const appCfg = app.config.oauth?.githubApp;
  // App flow takes precedence whenever both are configured during the
  // transition window. After D3 cutover only `appCfg` remains.
  if (!appCfg && !oauthCfg) {
    app.log.info(
      "GitHub sign-in not configured — /auth/github/start will return 503. " +
        "Set FIRST_TREE_HUB_GITHUB_APP_* (preferred) or FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_ID/_SECRET to enable.",
    );
  }

  // Rate-limit `/start` more tightly than the global default — minting state
  // tokens is cheap server-side but a flood inflates the cookie+JWT budget
  // a single browser carries, so cap at 20/min/IP.
  app.get("/start", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { next } = githubStartQuerySchema.parse(request.query);
    const safeNext = safeRedirectPath(next ?? null);
    if (!appCfg && !oauthCfg) {
      return reply.status(503).send({ error: "GitHub sign-in is not configured on this hub" });
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
    if (appCfg) {
      // App flow: scope/permissions are declared on the App's GitHub-side
      // settings page (D0b), so we don't pass them here. The user lands on
      // the combined OAuth + install dialog.
      return reply.redirect(buildAppAuthorizeUrl({ clientId: appCfg.clientId, redirectUri, state: token }), 302);
    }
    // Legacy OAuth flow — kept until D3 cutover. `oauthCfg` is non-null
    // here because of the guard above + `!appCfg` short-circuit above.
    // biome-ignore lint/style/noNonNullAssertion: guard upstream proves it
    const legacy = oauthCfg!;
    const params = new URLSearchParams({
      client_id: legacy.clientId,
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
    if (!appCfg && !oauthCfg) {
      return reply.status(503).send({ error: "GitHub sign-in is not configured on this hub" });
    }
    const parsed = githubCallbackQuerySchema.parse(request.query);
    const { code, state, installation_id: installationIdRaw } = parsed;
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
    let tokens: GithubTokenBundle;
    let installationId: number | null = null;
    try {
      if (appCfg) {
        const result = await exchangeCodeForAppUserProfile({
          clientId: appCfg.clientId,
          clientSecret: appCfg.clientSecret,
          code,
          redirectUri,
          installationId: installationIdRaw ? Number(installationIdRaw) : null,
        });
        profile = result.profile;
        tokens = {
          encryptedAccessToken: encryptValue(result.accessToken, app.config.secrets.encryptionKey),
          accessTokenExpiresAt: result.accessTokenExpiresAt,
          encryptedRefreshToken: encryptValue(result.refreshToken, app.config.secrets.encryptionKey),
          refreshTokenExpiresAt: result.refreshTokenExpiresAt,
        };
        installationId = result.installationId;
      } else {
        // biome-ignore lint/style/noNonNullAssertion: !appCfg + guard upstream prove oauthCfg is set
        const legacy = oauthCfg!;
        const result = await exchangeCodeForProfile(
          { clientId: legacy.clientId, clientSecret: legacy.clientSecret },
          code,
          redirectUri,
        );
        profile = result.profile;
        tokens = {
          encryptedAccessToken: encryptValue(result.accessToken, app.config.secrets.encryptionKey),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "GitHub exchange failed";
      app.log.warn({ err }, "github sign-in code exchange failed");
      return reply.status(401).send({ error: msg });
    }

    // installationId plumbing into github_app_installations lands in the
    // next commit (install state machine). For now we log so a real
    // round-trip can be observed in dev/staging without it being silently
    // dropped.
    if (installationId !== null) {
      app.log.info(
        { event: "github_app.install_callback_received", installationId, githubId: profile.githubId },
        "github app install callback received — installation persistence wires up in a follow-up commit",
      );
    }

    return completeOauthFlow(app, request, reply, profile, next, tokens);
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
    // Optional dev-only PAT injection so the Step 2 repo picker has a real
    // GitHub access token to call APIs with. Set `DEV_GITHUB_PAT=ghp_...` in
    // the dev env to enable. Never read in production (the early-return
    // above already guards `dev-callback` itself).
    const devPat = process.env.DEV_GITHUB_PAT?.trim() || null;
    const tokens: GithubTokenBundle = devPat
      ? { encryptedAccessToken: encryptValue(devPat, app.config.secrets.encryptionKey) }
      : {};
    return completeOauthFlow(app, request, reply, profile, next, tokens);
  });
}

async function completeOauthFlow(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  profile: GithubProfile,
  next: string,
  /**
   * Persisted (encrypted) GitHub token bundle. Empty when called from
   * `dev-callback` without a `DEV_GITHUB_PAT` set, or — in the App flow —
   * always includes the full pair (access + refresh + expiries).
   */
  oauthTokens: GithubTokenBundle,
) {
  const { userId } = await findOrCreateUserFromGithub(app.db, profile, oauthTokens);

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
