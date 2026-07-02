import {
  githubCallbackQuerySchema,
  githubDevCallbackQuerySchema,
  githubStartQuerySchema,
  safeRedirectPath,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authIdentities } from "../../db/schema/auth-identities.js";
import { signTokensForUser } from "../../services/auth.js";
import {
  findOrCreateUserFromGithub,
  type GithubProfile,
  type GithubTokenBundle,
} from "../../services/auth-identity.js";
import { encryptValue } from "../../services/crypto.js";
import { buildAppAuthorizeUrl, exchangeCodeForAppUserProfile } from "../../services/github-app.js";
import { completeInstallBind, recordPendingBind } from "../../services/github-app-install-intents.js";
import { recordInstallRequest } from "../../services/github-app-install-requests.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../../services/github-app-installations.js";
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
 * installation_id`. The callback does NOT bind the installation: it records
 * a per-install pending bind (keyed by `installation_id`, authorized by the
 * signed kickoff state — `kickoffUserId`), and the actual bind is performed by
 * the trusted, HMAC-signed `installation.created` webhook once it proves the
 * installer IS the kickoff admin (and re-checks live admin). The URL
 * `installation_id` is only a correlation handle; a forged one never binds.
 * The browser's github.com session is independent of the First Tree session.
 *
 * The live `/callback` is a full-page browser navigation, so its error
 * replies redirect to the SPA error surface
 * (`/auth/github/complete#error=<code>`) instead of raw JSON.
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

  app.get("/start", async (request, reply) => {
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
    // `installation_id` from the URL is unsigned/forgeable, so it is NEVER a
    // binding authority on its own. On the kickoff install path it is used
    // only as a *correlation handle*: we record a per-install pending bind,
    // and the trusted `installation.created` webhook completes it only after
    // proving this installation's installer is the kickoff admin.
    const { code, state, installation_id: installationIdRaw, setup_action: setupAction } = parsed;
    const cookieNonce = parseCookieHeader(request.headers.cookie, OAUTH_STATE_COOKIE);

    let next: string;
    let targetOrganizationId: string | null = null;
    let kickoffUserId: string | null = null;
    try {
      const verified = await verifyOAuthState(app.config.secrets.jwtSecret, state, cookieNonce);
      next = verified.next;
      targetOrganizationId = verified.targetOrganizationId ?? null;
      kickoffUserId = verified.kickoffUserId ?? null;
    } catch (err) {
      // Browser-facing: the user just navigated here from github.com. A raw
      // JSON body would strand them on the API URL — most commonly after
      // taking >10min on GitHub's repo picker (state JWT expiry).
      app.log.warn(
        { err, event: "github_oauth.state_rejected" },
        "github callback state rejected — redirecting to SPA error surface",
      );
      return redirectCallbackError(reply, "state-expired");
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

    // Approval-flow capture (#1392). When a non-owner First Tree admin
    // initiates the install, GitHub can't install directly — it records a
    // request for an org owner to approve and redirects here with
    // `setup_action=request`, BEFORE any installation exists (no
    // `installation_id`, and possibly no OAuth `code`). GitHub gives no
    // correlation signal at approval time (the `installation.created` `sender`
    // is the approver, not the requester), so we capture the request NOW,
    // keyed by the initiator — known from our own signed state (`kickoffUserId`)
    // — so the initiator can complete the bind on return after approval. The
    // instrumentation log records the real request-callback shape for the
    // staging validation (does GitHub route it here at all? carry a `code`?).
    if (setupAction === "request") {
      app.log.info(
        {
          event: "github_app.install_request_callback",
          hasCode: Boolean(code),
          installationId: installationIdRaw ?? null,
          targetOrganizationId,
          kickoffUserId,
          rawQueryKeys: Object.keys((request.query as Record<string, unknown>) ?? {}),
        },
        "install-request callback (setup_action=request) — capture + instrument",
      );
      if (targetOrganizationId && kickoffUserId) {
        const [kickoffIdentity] = await app.db
          .select({ identifier: authIdentities.identifier })
          .from(authIdentities)
          .where(and(eq(authIdentities.userId, kickoffUserId), eq(authIdentities.provider, "github")))
          .limit(1);
        const initiatorGithubId = kickoffIdentity?.identifier ? Number(kickoffIdentity.identifier) : Number.NaN;
        if (Number.isFinite(initiatorGithubId)) {
          await recordInstallRequest(app.db, { initiatorGithubId, targetOrganizationId, kickoffUserId });
        } else {
          app.log.warn(
            { kickoffUserId, targetOrganizationId },
            "install-request: kickoff user has no GitHub identity on file — cannot capture request",
          );
        }
      }
      // The install is pending an org owner's approval; nothing to bind yet.
      // Bounce back to the kickoff surface (Settings / onboarding), which
      // surfaces the pending state and lets the initiator complete on return.
      return reply.redirect(next, 302);
    }

    if (!code) {
      // Non-request callbacks must carry an OAuth code (login / install-complete).
      app.log.warn({ setupAction }, "github callback missing code on a non-request flow");
      return redirectCallbackError(reply, "github-exchange-failed", next);
    }

    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/github/callback`;
    let profile: GithubProfile;
    let tokens: GithubTokenBundle;
    try {
      const result = await exchangeCodeForAppUserProfile({
        clientId: appCfg.clientId,
        clientSecret: appCfg.clientSecret,
        code,
        redirectUri,
        // The OAuth code exchange resolves the signing-in identity for LOGIN.
        // It is not an installation-binding input, so we don't thread the URL
        // `installation_id` through it; binding is handled separately via the
        // per-install pending bind + trusted `installation.created` webhook.
        installationId: null,
      });
      profile = result.profile;
      tokens = {
        encryptedAccessToken: encryptValue(result.accessToken, app.config.secrets.encryptionKey),
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        encryptedRefreshToken: encryptValue(result.refreshToken, app.config.secrets.encryptionKey),
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
      };
    } catch (err) {
      app.log.warn({ err }, "github sign-in code exchange failed");
      return redirectCallbackError(reply, "github-exchange-failed", next);
    }

    // Pass the URL `installation_id` (validated to a finite number, else null)
    // through to completeOauthFlow. It is used ONLY inside the kickoff branch,
    // and ONLY after that branch proves the OAuth-resolved user IS the kickoff
    // admin — so no install-bind side effect happens on an identity mismatch
    // (the pending-bind record + `completeInstallBind` live there, not here).
    const callbackInstallationId =
      installationIdRaw && Number.isFinite(Number(installationIdRaw)) ? Number(installationIdRaw) : null;

    return completeOauthFlow(app, request, reply, profile, next, tokens, callbackInstallationId, targetOrganizationId, {
      kickoffUserId,
      browserFacing: true,
    });
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
              administration: "write",
              contents: "write",
              workflows: "write",
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
    return completeOauthFlow(app, request, reply, profile, next, tokens, devInstallationId, null, {
      devBindInstallation: true,
    });
  });
}

/**
 * Error codes the SPA's `/auth/github/complete` page renders friendly copy
 * for. Keep in sync with `packages/web/src/pages/oauth-complete.tsx`.
 */
type CallbackErrorCode =
  | "state-expired"
  | "github-exchange-failed"
  | "install-not-admin"
  | "install-not-verified"
  | "install-bind-failed"
  | "invite-invalid"
  | "invite-not-allowed"
  | "invite-required"
  | "membership-unresolved";

/**
 * The live `/callback` route is a full-page browser navigation (GitHub
 * redirects the user's browser here), so error replies must land the user
 * back on the SPA — a raw JSON body strands them on the API URL with no
 * way forward. The error code rides in the fragment like the success
 * tokens do (never enters Referer headers or server logs).
 *
 * `next` becomes the error page's visible "Back to First Tree" link, so it
 * must be a real recovery surface: the onboarding popup's auto-close
 * "Connected" sentinel (`/onboarding/connected`) would present a
 * false-success escape hatch right on the failure page — normalize it to
 * the onboarding flow itself.
 */
function redirectCallbackError(reply: FastifyReply, code: CallbackErrorCode, next?: string) {
  const recoveryNext = next === "/onboarding/connected" ? "/onboarding" : next;
  const fragment = new URLSearchParams({ error: code, ...(recoveryNext ? { next: recoveryNext } : {}) }).toString();
  return reply.redirect(`/auth/github/complete#${fragment}`, 302);
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
   * The URL `installation_id` (validated) from the callback, or null. It is a
   * correlation handle, NOT a binding authority: it is used ONLY inside the
   * kickoff branch, and only after that branch proves the OAuth-resolved user
   * is the kickoff admin, to record a per-install pending bind that the signed
   * `installation.created` webhook then completes. `dev-callback` passes its
   * stub id together with `opts.devBindInstallation` for a direct QA bind.
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
  opts: {
    /**
     * First Tree user who kicked off the App-install flow, carried in the
     * signed state (see `StatePayload.kickoffUserId`). Null on the plain
     * sign-in flow, legacy states, and `dev-callback`.
     */
    kickoffUserId?: string | null;
    /**
     * True when the caller is the live browser-navigated `/callback`
     * route: error replies redirect to the SPA error surface instead of
     * raw JSON. `dev-callback` keeps JSON errors (curl-able, and the
     * dev/test suites assert on status codes).
     */
    browserFacing?: boolean;
    /**
     * DEV-CALLBACK ONLY. When true, the `installationId` stub is bound
     * directly to the resolved org (so a local QA session looks connected
     * without a real webhook). The real `/callback` never sets this — its
     * binding is webhook-driven.
     */
    devBindInstallation?: boolean;
  } = {},
) {
  const { kickoffUserId = null, browserFacing = false, devBindInstallation = false } = opts;
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
  // Whether the resolved org is a *deliberate* destination the SPA must
  // activate (invite link, fresh solo signup, or an App-install target),
  // versus a plain returning sign-in whose org the client restores from its
  // own last-used selection. `joinPath` cannot carry this on its own: the
  // App-install target path keeps `joinPath="returning"` (it reuses the
  // caller's Settings `next`) yet still names a specific org to pin.
  let orgPinned = false;

  if (inviteMatch?.[1]) {
    const token = inviteMatch[1];
    const inv = await findActiveByToken(app.db, token);
    if (!inv) {
      if (browserFacing) return redirectCallbackError(reply, "invite-invalid");
      return reply.status(404).send({ error: "Invitation not found or no longer valid" });
    }
    if (allowedOrganizationId && inv.organizationId !== allowedOrganizationId) {
      if (browserFacing) return redirectCallbackError(reply, "invite-not-allowed");
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
    orgPinned = true;
    // Drop the now-consumed invite path; land on the team dashboard so the
    // onboarding modal can layer on top.
    next = "/";
  } else if (targetOrganizationId) {
    // App-install flow: the org rode in the signed state minted by the
    // admin-gated `/install-url` (codex P1-3). The bind rests on the
    // KICKOFF user's authority — re-checked live against `members`,
    // because the state JWT outlives a membership revoke — and NOT on the
    // identity the OAuth code resolved to: the browser's github.com
    // session is independent of the First Tree session, and a mismatch
    // (second GitHub account, deleted-and-recreated account, someone
    // else's First Tree session in the same browser) must not strand a
    // completed install unbound. States minted before `kickoffUserId`
    // existed (≤10min old at deploy time) fall back to the OAuth identity.
    const bindAuthorityUserId = kickoffUserId ?? userId;
    const authority = await findActiveMembership(app.db, bindAuthorityUserId, targetOrganizationId);
    if (!authority || authority.role !== "admin") {
      app.log.warn(
        {
          event: "github_app.install_callback_admin_check_failed",
          targetOrganizationId,
          kickoffUserId,
          oauthUserId: userId,
          githubId: profile.githubId,
          githubLogin: profile.login,
          installationId,
        },
        "install callback: bind authority is not an active admin of the target org — refusing to bind",
      );
      if (browserFacing) return redirectCallbackError(reply, "install-not-admin", next);
      return reply.status(403).send({ error: "Not an admin of the First Tree organization this installation targets" });
    }
    if (bindAuthorityUserId !== userId) {
      // The install was completed under a DIFFERENT GitHub identity than the
      // admin who kicked it off — the browser's github.com session differs
      // from the First Tree kickoff admin (a second GitHub account, someone
      // else's github.com session in the same browser, …). Binding requires
      // installer == kickoff admin: the install-intent is keyed by the
      // kickoff admin's GitHub id and the trusted `installation.created`
      // webhook only binds when its `sender` matches, so this install will
      // NOT bind. Surface it as an error rather than sign the browser in as
      // the foreign identity (which would replace the kickoff admin's
      // session in every tab). Install must use the same GitHub account you
      // signed in / started the install with.
      app.log.warn(
        {
          event: "github_app.install_callback_identity_mismatch",
          targetOrganizationId,
          kickoffUserId: bindAuthorityUserId,
          oauthUserId: userId,
          githubId: profile.githubId,
          githubLogin: profile.login,
        },
        "install callback: OAuth identity differs from the kickoff admin — refusing (install must use the same GitHub account)",
      );
      return redirectCallbackError(reply, "install-not-verified", next);
    }
    // Identity match confirmed (OAuth-resolved user IS the kickoff admin, who
    // is an active admin of the target org — checked above). ONLY NOW is it
    // safe to record the per-install pending bind: recording it before the
    // mismatch guard would let a callback under a foreign identity trigger a
    // bind side effect while still returning `install-not-verified`. Here
    // `profile.githubId` is the kickoff admin's GitHub id, so the trusted
    // `installation.created` webhook completes the bind only when THIS
    // installation's installer matches (and the admin is still active).
    // `completeInstallBind` also covers the webhook-arrived-before-callback
    // ordering. Non-fatal on error — the webhook retries completion.
    if (installationId !== null) {
      try {
        await recordPendingBind(app.db, {
          installationId,
          targetOrganizationId,
          kickoffUserId: bindAuthorityUserId,
          kickoffGithubId: Number(profile.githubId),
        });
        await completeInstallBind(app.db, installationId);
      } catch (err) {
        app.log.warn(
          { err, installationId, targetOrganizationId, kickoffUserId: bindAuthorityUserId },
          "install pending-bind record/complete failed in callback — webhook will retry",
        );
      }
    }
    resolved = true;
    resolvedOrganizationId = targetOrganizationId;
    // joinPath stays "returning"; keep caller's `next` (the Settings page)
    // so the panel re-renders with the now-bound installation. Pin the org
    // explicitly: this is a deliberate App-install destination, so the SPA
    // must activate the just-bound org even though the join path reads as a
    // returning sign-in — otherwise a concurrent org switch in another tab
    // would land the Settings page on the user's last-used org instead.
    orgPinned = true;
  } else {
    const primary = await pickPrimaryMembership(app.db, userId);
    if (primary) {
      resolved = true;
      resolvedOrganizationId = primary.organizationId;
      // joinPath stays "returning"; preserve caller's original `next` intent.
    } else {
      if (allowedOrganizationId) {
        if (browserFacing) return redirectCallbackError(reply, "invite-required");
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
      orgPinned = true;
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

  // Direct installation bind — DEV-CALLBACK ONLY, gated by `devBindInstallation`.
  // The real `/callback` NEVER sets that flag: real binding is driven
  // exclusively by the trusted, HMAC-signed `installation.created` webhook via
  // the per-install pending bind recorded above, never by the browser-supplied
  // URL id. `dev-callback` passes a stub installation id + the flag so a local
  // QA session looks connected without a real webhook. The flag gate (not just
  // `installationId !== null`) is essential now that the real callback DOES
  // pass a URL `installation_id` for the kickoff pending bind — binding it here
  // would reopen the URL-forgery hole.
  if (devBindInstallation && installationId !== null && resolvedOrganizationId) {
    try {
      await bindInstallationToOrg(app.db, installationId, resolvedOrganizationId);
    } catch (err) {
      app.log.warn(
        { err, installationId, hubOrganizationId: resolvedOrganizationId, userId },
        "dev-callback install bind-to-org failed — sign-in continues",
      );
    }
  }

  // NOTE: the previous sign-in-time orphan-install auto-reclaim sweep (which
  // matched unbound rows by the user's GitHub *account* id and auto-bound the
  // single match) is removed. Binding is now webhook-driven, and recovery of
  // an unbound install goes through the explicit `POST /claim`, which matches
  // on the trusted `installer_github_id` (the webhook `sender`) rather than
  // mere account membership.

  if (!resolved) {
    if (browserFacing) return redirectCallbackError(reply, "membership-unresolved");
    return reply.status(500).send({ error: "Failed to resolve membership" });
  }

  const tokens = await signTokensForUser(app.config.secrets.jwtSecret, userId, app.config.auth);

  // Carry the org this callback resolved to (the invited org for an invite
  // link, an App-install target, otherwise the user's primary/personal org)
  // so the web can make it the active selection. `orgPinned=1` marks the
  // deliberate destinations (invite / solo / install-target) the SPA must
  // activate; without it the client keeps its own last-used selection, which
  // is the intended behaviour for a plain returning sign-in but would drop an
  // invitee — or an install-return — into their *previous* org.
  const fragmentParams: Record<string, string> = {
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    next,
    joinPath,
  };
  if (resolvedOrganizationId) fragmentParams.org = resolvedOrganizationId;
  if (orgPinned) fragmentParams.orgPinned = "1";
  const fragment = new URLSearchParams(fragmentParams).toString();
  return reply.redirect(`/auth/github/complete#${fragment}`, 302);
}
