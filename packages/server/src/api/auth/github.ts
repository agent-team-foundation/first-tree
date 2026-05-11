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
import {
  buildAppAuthorizeUrl,
  createAppJwt,
  exchangeCodeForAppUserProfile,
  fetchInstallation,
} from "../../services/github-app.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../../services/github-app-installations.js";
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

    // Fetch + UPSERT the installation row when the user just installed
    // the App. We pull the metadata from GitHub's API (rather than wait
    // for the `installation: created` webhook) so the callback doesn't
    // depend on webhook delivery order — and so the Settings panel can
    // render the connected-account block on the very next page load.
    //
    // Bind-to-org happens after `completeOauthFlow` has resolved which
    // Hub team the user lands on (existing primary, invite redemption,
    // or a freshly-minted personal team).
    if (installationId !== null && appCfg) {
      try {
        const appJwt = await createAppJwt({ appId: appCfg.appId, privateKeyPem: appCfg.privateKeyPem });
        const installation = await fetchInstallation(appJwt, installationId);
        await upsertInstallationFromMetadata(app.db, { installation });
      } catch (err) {
        // Log + continue. The webhook handler (commit 7) will land the
        // same row on its own; degrading gracefully here means the user
        // still gets signed in even if GitHub's App API is briefly down.
        app.log.warn(
          { err, installationId, githubId: profile.githubId },
          "github app install fetch/upsert failed — webhook will reconcile",
        );
      }
    }

    return completeOauthFlow(app, request, reply, profile, next, tokens, installationId);
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

    // App-flow dev bypass: when the request supplied an `installationId`,
    // stub a `github_app_installations` row before completing the OAuth
    // flow so the rest of the dev session looks identical to a real
    // post-install state — Settings → Integrations renders the connected
    // account, the App webhook endpoint resolves the binding, etc.
    //
    // Unlike the real path (which fetches metadata from GitHub), we just
    // mint the row directly. The `permissions` / `events` blocks mirror
    // what the App declares on its GitHub-side settings page (D0b) so the
    // dev row matches what a real install would look like for QA purposes.
    let devInstallationId: number | null = null;
    if (params.installationId) {
      devInstallationId = Number(params.installationId);
      try {
        await upsertInstallationFromMetadata(app.db, {
          installation: {
            id: devInstallationId,
            accountType: params.installationAccountType ?? "User",
            accountLogin: params.installationAccountLogin ?? params.login,
            accountGithubId: Number(params.installationAccountGithubId ?? params.githubId),
            permissions: {
              contents: "write",
              pull_requests: "write",
              issues: "read",
              metadata: "read",
              members: "read",
            },
            events: [
              "issues",
              "issue_comment",
              "pull_request",
              "pull_request_review",
              "push",
              "installation",
              "installation_repositories",
              "member",
            ],
            suspendedAt: null,
          },
        });
      } catch (err) {
        // Dev-only path; log and continue so a bad query string doesn't
        // brick local sign-in. The OAuth flow still completes; bind is
        // attempted below and will simply fail to find the row.
        app.log.warn({ err, installationId: devInstallationId }, "dev-callback installation stub upsert failed");
      }
    }

    return completeOauthFlow(app, request, reply, profile, next, tokens, devInstallationId);
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
  /**
   * GitHub-side installation id when the user just installed the App;
   * null on the legacy OAuth path, returning App users without a fresh
   * install, and `dev-callback`. Used after team resolution to bind the
   * installation row to the user's Hub team.
   */
  installationId: number | null,
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
  let resolvedOrganizationId: string | null = null;

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
    resolvedOrganizationId = inv.organizationId;
    // Drop the now-consumed invite path; land on the team dashboard so the
    // onboarding modal can layer on top.
    next = "/";
  } else {
    const primary = await pickPrimaryMembership(app.db, userId);
    if (primary) {
      resolved = true;
      resolvedOrganizationId = primary.organizationId;
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
      resolvedOrganizationId = personal.organizationId;
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

  // Bind the installation to whichever Hub team the user just resolved
  // into. Late-bound (after team resolution) so a personal-team-creating
  // signup ends up bound to the team it just minted, and an invitee binds
  // to the inviting org.
  //
  // Tolerates the "already bound to this org" no-op case (idempotent on
  // returning sign-ins). Refuses to rebind to a different org per D2 1:1
  // — that path logs a warning and lets the sign-in succeed; the
  // installation stays attached to whoever installed it first, which is
  // the documented design (no "transfer install" UX yet).
  if (installationId !== null && resolvedOrganizationId) {
    try {
      await bindInstallationToOrg(app.db, installationId, resolvedOrganizationId);
    } catch (err) {
      app.log.warn(
        { err, installationId, hubOrganizationId: resolvedOrganizationId, userId },
        "github app install bind-to-org failed — sign-in continues; reconcile in Settings",
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
