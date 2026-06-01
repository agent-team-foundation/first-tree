import {
  githubCallbackQuerySchema,
  githubDevCallbackQuerySchema,
  githubStartQuerySchema,
  safeRedirectPath,
} from "@first-tree/shared";
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
  verifyUserCanAdministerInstallation,
} from "../../services/github-app.js";
import {
  bindInstallationToOrg,
  findUnboundInstallationsByAccount,
  upsertInstallationFromMetadata,
} from "../../services/github-app-installations.js";
import { findActiveByToken, recordRedemption } from "../../services/invitation.js";
import {
  createPersonalTeam,
  ensureMembership,
  findActiveMembership,
  pickPrimaryMembership,
} from "../../services/membership.js";
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
 * `/start` uses the GitHub App **authorize** URL — this is identity only
 * (sign-in / re-auth). For a user who already has the App installed the
 * callback may also carry an `installation_id`, but for a user who has NOT
 * installed it the authorize URL never surfaces the install dialog and
 * never returns an `installation_id` (codex P1-1; see
 * `services/github-app.ts`). So sign-in must not be relied on to install
 * the App. The reliable install entry is `installations/new`, exposed at
 * `GET /orgs/:orgId/github-app-installation/install-url` and surfaced both
 * in onboarding's "Connect your code" step and Settings → GitHub. After
 * that dialog GitHub redirects back here with `code + state +
 * installation_id`, which the callback verifies and binds.
 *
 * `dev-callback` bypasses GitHub entirely; gated to non-production.
 *
 * Routes:
 *   - GET /auth/github/start         — sign state JWT + cookie + 302 to GitHub
 *   - GET /auth/github/callback      — verify state + exchange code → fragment
 *   - GET /auth/github/dev-callback  — dev-only stub (no GitHub round-trip)
 */
export async function githubOauthRoutes(app: FastifyInstance): Promise<void> {
  const appCfg = app.config.oauth?.githubApp;
  if (!appCfg) {
    app.log.info(
      "GitHub App not configured — /auth/github/start will return 503. Set FIRST_TREE_GITHUB_APP_* to enable.",
    );
  }

  // Rate-limit `/start` more tightly than the global default — minting state
  // tokens is cheap server-side but a flood inflates the cookie+JWT budget
  // a single browser carries, so cap at 20/min/IP.
  app.get("/start", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { next } = githubStartQuerySchema.parse(request.query);
    const safeNext = safeRedirectPath(next ?? null);
    if (!appCfg) {
      return reply.status(503).send({ error: "GitHub App is not configured on this First Tree deployment" });
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
    // App flow: scope/permissions are declared on the App's GitHub-side
    // settings page (D0b), so we don't pass them here. The user lands on
    // the combined OAuth + install dialog (first-time installer) or just
    // the OAuth consent (returning user).
    return reply.redirect(buildAppAuthorizeUrl({ clientId: appCfg.clientId, redirectUri, state: token }), 302);
  });

  app.get("/callback", async (request, reply) => {
    if (!appCfg) {
      return reply.status(503).send({ error: "GitHub App is not configured on this First Tree deployment" });
    }
    const parsed = githubCallbackQuerySchema.parse(request.query);
    const { code, state, installation_id: installationIdRaw } = parsed;
    const cookieNonce = parseCookieHeader(request.headers.cookie, OAUTH_STATE_COOKIE);

    let next: string;
    let targetOrganizationId: string | null = null;
    try {
      const verified = await verifyOAuthState(app.config.secrets.jwtSecret, state, cookieNonce);
      next = verified.next;
      targetOrganizationId = verified.targetOrganizationId ?? null;
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
    let plaintextUserAccessToken: string;
    let installationId: number | null = null;
    try {
      const result = await exchangeCodeForAppUserProfile({
        clientId: appCfg.clientId,
        clientSecret: appCfg.clientSecret,
        code,
        redirectUri,
        installationId: installationIdRaw ? Number(installationIdRaw) : null,
      });
      profile = result.profile;
      plaintextUserAccessToken = result.accessToken;
      tokens = {
        encryptedAccessToken: encryptValue(result.accessToken, app.config.secrets.encryptionKey),
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        encryptedRefreshToken: encryptValue(result.refreshToken, app.config.secrets.encryptionKey),
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
      };
      installationId = result.installationId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "GitHub exchange failed";
      app.log.warn({ err }, "github sign-in code exchange failed");
      return reply.status(401).send({ error: msg });
    }

    // SECURITY: `installation_id` rides the browser address bar — not a
    // secret, not signed. Any signed-in user could append
    // `?installation_id=<other-team's-id>` and bind that installation to
    // their own First Tree team if we don't authorize first (the App JWT can
    // read every installation, so `fetchInstallation` would succeed).
    //
    // Require GitHub-side **admin** on the install's account: User-type
    // owner-match, Org-type admin via `/user/memberships/orgs/{login}`.
    // Plain read access via org membership isn't enough — that's what
    // made the original `/user/installations` primitive forgeable.
    //
    // We fetch the installation first to get its account metadata, then
    // verify, then upsert. On any failure — verify / fetch / upsert —
    // we drop `installationId` so sign-in still succeeds but no row is
    // bound; the user can re-trigger install from Settings.
    if (installationId !== null && appCfg) {
      try {
        const appJwt = await createAppJwt({ appId: appCfg.appId, privateKeyPem: appCfg.privateKeyPem });
        const installation = await fetchInstallation(appJwt, installationId);
        const canAdminister = await verifyUserCanAdministerInstallation(
          plaintextUserAccessToken,
          Number(profile.githubId),
          installation,
        );
        if (!canAdminister) {
          app.log.warn(
            {
              event: "github_app.installation_id_unauthorized",
              installationId,
              githubId: profile.githubId,
              accountType: installation.accountType,
              accountLogin: installation.accountLogin,
            },
            "callback installation_id admin proof failed — refusing to bind",
          );
          installationId = null;
        } else {
          await upsertInstallationFromMetadata(app.db, { installation });
        }
      } catch (err) {
        // Failing closed: fetch / membership API / upsert all roll up
        // here so we never half-bind. User still signs in; the Settings
        // panel surfaces a clean "Install" CTA for retry.
        app.log.warn(
          { err, installationId, githubId: profile.githubId },
          "github app install verify/upsert failed — clearing installation_id, user can retry from Settings",
        );
        installationId = null;
      }
    }

    return completeOauthFlow(app, request, reply, profile, next, tokens, installationId, targetOrganizationId);
  });

  app.get("/dev-callback", async (request, reply) => {
    // dev-callback mints a stub GitHub identity (and, post-PR-300, a
    // stub GitHub App installation) without round-tripping to
    // github.com. Two-gate access control to defeat the codex P1-9
    // failure mode where a misconfigured staging deploy with `NODE_ENV`
    // unset would leak this bypass:
    //
    //   Gate 1: NODE_ENV must not be 'production'. Same as before —
    //           defense-in-depth, blocks the dumbest mistake.
    //   Gate 2: FIRST_TREE_DEV_CALLBACK_ENABLED must be explicitly
    //           "1" or "true". An unset env var defaults to disabled —
    //           operators MUST opt in. Vitest's setup script
    //           (`vitest.setup.ts`) sets this to "1" so the existing
    //           dev-callback test suite keeps working without per-test
    //           plumbing.
    //
    // Either gate failing → 404 (not 403 — we don't want to confirm the
    // route exists at all to unauthenticated callers).
    if (process.env.NODE_ENV === "production") {
      return reply.status(404).send({ error: "Not found" });
    }
    const devCallbackOptIn = process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
    if (devCallbackOptIn !== "1" && devCallbackOptIn !== "true") {
      app.log.info({ url: request.url }, "dev-callback request refused — FIRST_TREE_DEV_CALLBACK_ENABLED is not set");
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

    // Dev bypass never carries a `targetOrganizationId` — the install
    // stub binds to whatever team the dev session resolves into.
    return completeOauthFlow(app, request, reply, profile, next, tokens, devInstallationId, null);
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
   * `dev-callback` without a `DEV_GITHUB_PAT` set; otherwise — in the
   * App flow — typically includes the full pair (access + refresh +
   * expiries). The `dev-callback` path also reaches here with an empty
   * bundle, so callers must tolerate the empty shape.
   */
  oauthTokens: GithubTokenBundle,
  /**
   * GitHub-side installation id when the user just installed the App;
   * null on the legacy OAuth path, returning App users without a fresh
   * install, and `dev-callback`. Used after team resolution to bind the
   * installation row to the user's First Tree team.
   */
  installationId: number | null,
  /**
   * First Tree org the install should bind to, carried in the signed state when
   * the flow was kicked off from an org's Settings panel (codex P1-3).
   * The user MUST be an active admin of it (re-checked here against the
   * live `members` row — the state JWT outlives a membership revoke).
   * Overridden by invite-redemption: if `next` is an `/invite/<token>`
   * path, that org wins regardless. Null on the plain sign-in flow.
   */
  targetOrganizationId: string | null,
) {
  const { userId } = await findOrCreateUserFromGithub(app.db, profile, oauthTokens);
  const allowedOrganizationId = app.config.access?.allowedOrganizationId ?? null;

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
    if (allowedOrganizationId && inv.organizationId !== allowedOrganizationId) {
      return reply.status(403).send({ error: "Invitation is not allowed on this server" });
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
  } else if (targetOrganizationId) {
    // App-install flow: the org was chosen on a Settings page and rode in
    // the signed state (codex P1-3). Re-check the user is still an active
    // admin of it — the state JWT outlives a membership revoke, so a stale
    // token must not bind another team's install to an org the user no
    // longer administers.
    const membership = await findActiveMembership(app.db, userId, targetOrganizationId);
    if (!membership || membership.role !== "admin") {
      return reply.status(403).send({ error: "Not an admin of the organization this installation targets" });
    }
    resolved = true;
    resolvedOrganizationId = targetOrganizationId;
    // joinPath stays "returning"; keep caller's `next` (the Settings page)
    // so the panel re-renders with the now-bound installation.
  } else {
    const primary = await pickPrimaryMembership(app.db, userId);
    if (primary) {
      resolved = true;
      resolvedOrganizationId = primary.organizationId;
      // joinPath stays "returning"; preserve caller's original `next` intent.
    } else {
      if (allowedOrganizationId) {
        return reply.status(403).send({ error: "This server requires an invitation link to join" });
      }
      const personal = await createPersonalTeam(app.db, {
        userId,
        loginSeed: profile.login,
        // Per first-tree-context:agent-hub/onboarding.md (was §5.5 in source design), default team name is
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

  // Bind the installation to whichever First Tree team the user just resolved
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

  // Orphan-install reclaim (codex P1-5 + H1): if a prior sign-in UPSERTed
  // an installation row but the bind step failed, the row stays unbound
  // forever — GitHub only sends `installation_id` on the initial install,
  // so a later sign-in never re-attempts the bind via the branch above.
  // Sweep here for unbound rows whose GitHub account is *this user's own*
  // personal account (the same authorization basis the callback's
  // `/user/installations` check enforced when the row was first written),
  // and auto-claim if there's exactly one. Multiple → leave them for the
  // manual `POST /claim` endpoint to disambiguate (the Settings "Claim install"
  // UI that drives that endpoint is tracked in #318).
  if (resolvedOrganizationId) {
    try {
      const orphans = await findUnboundInstallationsByAccount(app.db, Number(profile.githubId));
      if (orphans.length === 1) {
        const orphan = orphans[0];
        if (orphan) {
          await bindInstallationToOrg(app.db, orphan.installationId, resolvedOrganizationId).catch((err) => {
            app.log.warn(
              { err, installationId: orphan.installationId, hubOrganizationId: resolvedOrganizationId, userId },
              "orphan install reclaim failed — operator can retry via POST /claim (UI tracked in #318)",
            );
          });
        }
      } else if (orphans.length > 1) {
        app.log.info(
          { count: orphans.length, accountGithubId: Number(profile.githubId), userId },
          "multiple unbound installs match this account — skipping auto-claim; operator must POST /claim to pick (UI #318)",
        );
      }
    } catch (err) {
      // The reclaim sweep is best-effort; a failure here must never block
      // sign-in.
      app.log.warn({ err, userId }, "orphan install reclaim sweep failed");
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
