import {
  githubCallbackQuerySchema,
  githubDevCallbackQuerySchema,
  githubExternalProfile,
  githubStartQuerySchema,
  safeRedirectPath,
} from "@first-tree/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { signTokensForUser } from "../../services/auth.js";
import {
  findOrCreateGithubAccount,
  type GithubProfile,
  type GithubTokenBundle,
  IdentityConflictError,
  IdentityMismatchError,
  LastIdentityError,
  linkExternalIdentity,
  unlinkExternalIdentity,
} from "../../services/auth-identity.js";
import { encryptValue } from "../../services/crypto.js";
import { buildAppAuthorizeUrl, exchangeCodeForAppUserProfile } from "../../services/github-app.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../../services/github-app-installations.js";
import { findActiveMembership } from "../../services/membership.js";
import { completeExternalAccountBootstrap, OAuthBootstrapError } from "../../services/oauth-bootstrap.js";
import {
  STATE_NONCE_COOKIE_NAME,
  STATE_NONCE_COOKIE_TTL_SECONDS,
  signOAuthState,
  verifyOAuthState,
} from "../../services/oauth-state.js";
import { resolvePublicUrl } from "../../utils/public-url.js";
import { buildCookie, protectOAuthStateNonce, readOAuthStateNonce } from "./oauth-cookie.js";

// OAuth link/unlink flows return the browser to the legacy /user-settings
// path on purpose: rolling deploys keep pre-Account SPA builds (which have no
// /settings/account route) in circulation, while the new SPA redirects
// /user-settings -> /settings/account with the query string intact, so both
// generations land on a working page. Switch this to /settings/account only
// once pre-Account SPA builds are out of circulation.
const ACCOUNT_RETURN_PATH = "/user-settings";

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
 * installation_id` (or without `code` when the install is parked for
 * owner approval, and without `state` when GitHub's own settings UI is
 * the origin). The callback does NOT bind the installation: the trusted,
 * HMAC-signed `installation.created` webhook records it unbound (with
 * its requester/installer GitHub ids), and a team admin explicitly
 * connects it from the Settings connect panel. The URL `installation_id`
 * is never a binding input; a forged one changes nothing. The browser's
 * github.com session is independent of the First Tree session.
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

    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, safeNext, {
      intent: "sign-in",
      provider: "github",
    });
    const isProd = process.env.NODE_ENV === "production";
    // The cookie stores only an application-key-encrypted, short-lived CSRF
    // nonce, not a provider credential or identity.
    const stateCookieHeader = buildCookie({
      name: STATE_NONCE_COOKIE_NAME,
      value: protectOAuthStateNonce(nonce, app.config.secrets.encryptionKey),
      maxAge: STATE_NONCE_COOKIE_TTL_SECONDS,
      secure: isProd,
    });
    reply.header("Set-Cookie", stateCookieHeader);

    const redirectUri = `${resolvePublicUrl(app, request)}/api/v1/auth/github/callback`;
    app.log.info({ event: "oauth.start", provider: "github", intent: "sign-in" }, "OAuth flow started");
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
    // binding authority. Binding is an explicit connect-panel action against
    // the row the trusted `installation.created` webhook recorded.
    const { code, state, error: providerError, installation_id: installationIdRaw } = parsed;

    if (!state) {
      // Stateless setup landing — GitHub redirects here from its OWN
      // settings UI (an org owner approving or reconfiguring the App) with
      // `setup_action` + `installation_id` but no First Tree state. Nothing
      // to verify and nobody to sign in: the webhook records the
      // installation, and connecting it is a panel action. Land the browser
      // on the SPA instead of the raw Zod error page this shape used to
      // produce.
      app.log.info(
        { event: "github_oauth.setup_landing_stateless", setupAction: parsed.setup_action ?? null },
        "github callback without state — landing on SPA",
      );
      return reply.redirect("/", 302);
    }

    const cookieNonce = readOAuthStateNonce(
      request.headers.cookie,
      STATE_NONCE_COOKIE_NAME,
      app.config.secrets.encryptionKey,
    );

    let next: string;
    let targetOrganizationId: string | null = null;
    let kickoffUserId: string | null = null;
    let intent: CallbackIntent = "sign-in";
    let stateUserId: string | null = null;
    let targetIdentityId: string | null = null;
    let verified: Awaited<ReturnType<typeof verifyOAuthState>>;
    try {
      verified = await verifyOAuthState(app.config.secrets.jwtSecret, state, cookieNonce);
      next = verified.next;
      targetOrganizationId = verified.targetOrganizationId ?? null;
      kickoffUserId = verified.kickoffUserId ?? null;
      intent = verified.intent ?? (targetOrganizationId ? "install" : "sign-in");
      stateUserId = verified.userId ?? null;
      targetIdentityId = verified.targetIdentityId ?? null;
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

    // A verified state is single-use whether GitHub returns a code, a
    // provider denial, or an approval-request setup landing.
    // This Set-Cookie value is intentionally empty and expires the nonce; it
    // does not persist the verified state or any other sensitive value.
    const expiredStateCookieHeader = buildCookie({
      name: STATE_NONCE_COOKIE_NAME,
      value: "",
      maxAge: 0,
      secure: process.env.NODE_ENV === "production",
    });
    reply.header("Set-Cookie", expiredStateCookieHeader);

    if (verified.provider && verified.provider !== "github") {
      app.log.warn(
        { event: "oauth.callback_rejected", provider: "github", reason: "provider-mismatch" },
        "OAuth state provider does not match callback",
      );
      return redirectCallbackError(reply, "state-expired", next, { callbackIntent: intent });
    }

    if (providerError) {
      app.log.info(
        { event: "oauth.provider_denied", provider: "github", intent },
        "GitHub authorization was denied or canceled",
      );
      return redirectCallbackError(reply, "provider-denied", next, { callbackIntent: intent });
    }

    if (!code) {
      // Kickoff round-trip that produced no OAuth code — the
      // `setup_action=request` shape: the user asked to install on an org
      // they don't own and GitHub parked the install pending owner approval
      // (observed on staging: no `code`, no `installation_id`). Their First
      // Tree session is untouched; send them back to the surface they
      // started from (`next` from the signed state), where the connect
      // panel's poll picks the installation up once an owner approves.
      app.log.info(
        { event: "github_oauth.setup_landing_no_code", setupAction: parsed.setup_action ?? null },
        "github callback without code — landing back on the kickoff surface",
      );
      return reply.redirect(next, 302);
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
        // `installation_id` through it; binding is an explicit connect-panel
        // action against the webhook-recorded row.
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
      app.log.warn({ err, event: "oauth.exchange_failed", provider: "github" }, "GitHub OAuth exchange failed");
      return redirectCallbackError(reply, "github-exchange-failed", next, { callbackIntent: intent });
    }

    // Pass the URL `installation_id` (validated to a finite number, else null)
    // through to completeOauthFlow. The real callback never binds it —
    // `completeOauthFlow` only uses it on the dev-callback QA path
    // (`devBindInstallation`); it rides along here purely for log context.
    const callbackInstallationId =
      installationIdRaw && Number.isFinite(Number(installationIdRaw)) ? Number(installationIdRaw) : null;

    if (intent === "link" || intent === "unlink") {
      if (!stateUserId)
        return redirectCallbackError(reply, "state-expired", ACCOUNT_RETURN_PATH, { callbackIntent: intent });
      const external = githubExternalProfile({
        id: profile.githubId,
        login: profile.login,
        name: profile.displayName,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
        metadata: {
          ...(tokens.encryptedAccessToken ? { accessToken: tokens.encryptedAccessToken } : {}),
          ...(tokens.accessTokenExpiresAt ? { accessTokenExpiresAt: tokens.accessTokenExpiresAt } : {}),
          ...(tokens.encryptedRefreshToken ? { refreshToken: tokens.encryptedRefreshToken } : {}),
          ...(tokens.refreshTokenExpiresAt ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } : {}),
        },
      });
      try {
        if (intent === "link") {
          await linkExternalIdentity(app.db, stateUserId, external);
          app.log.info({ event: "identity.linked", provider: "github", userId: stateUserId }, "Identity linked");
          return reply.redirect(`${ACCOUNT_RETURN_PATH}?connection=github-linked`, 302);
        }
        await unlinkExternalIdentity(
          app.db,
          stateUserId,
          "github",
          profile.githubId,
          {
            google: Boolean(app.config.oauth?.google),
            github: Boolean(app.config.oauth?.githubApp),
          },
          targetIdentityId ?? "",
        );
        app.log.info({ event: "identity.unlinked", provider: "github", userId: stateUserId }, "Identity unlinked");
        return reply.redirect(`${ACCOUNT_RETURN_PATH}?connection=github-unlinked`, 302);
      } catch (error) {
        if (error instanceof IdentityConflictError)
          return reply.redirect(`${ACCOUNT_RETURN_PATH}?error=identity-conflict`, 302);
        if (error instanceof IdentityMismatchError)
          return reply.redirect(`${ACCOUNT_RETURN_PATH}?error=identity-mismatch`, 302);
        if (error instanceof LastIdentityError)
          return reply.redirect(`${ACCOUNT_RETURN_PATH}?error=last-provider`, 302);
        throw error;
      }
    }

    return completeOauthFlow(app, request, reply, profile, next, tokens, callbackInstallationId, targetOrganizationId, {
      kickoffUserId,
      browserFacing: true,
      callbackIntent: intent === "install" ? "install" : "sign-in",
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
  | "provider-denied"
  | "provider-not-configured"
  | "provider-exchange-failed"
  | "identity-conflict"
  | "identity-mismatch"
  | "last-provider"
  | "github-exchange-failed"
  | "install-not-admin"
  | "install-not-verified"
  | "install-bind-failed"
  | "invite-invalid"
  | "invite-not-allowed"
  | "invite-required"
  | "membership-unresolved";

type CallbackIntent = "sign-in" | "link" | "unlink" | "install";

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
function redirectCallbackError(
  reply: FastifyReply,
  code: CallbackErrorCode,
  next?: string,
  metadata: { callbackIntent?: CallbackIntent; accountCreated?: boolean } = {},
) {
  const recoveryNext = next === "/onboarding/connected" ? "/onboarding" : next;
  const fragment = new URLSearchParams({
    error: code,
    ...(recoveryNext ? { next: recoveryNext } : {}),
    ...(metadata.callbackIntent ? { callbackIntent: metadata.callbackIntent } : {}),
    ...(metadata.accountCreated !== undefined ? { accountCreated: metadata.accountCreated ? "1" : "0" } : {}),
  }).toString();
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
   * The URL `installation_id` (validated) from the callback, or null. Never a
   * binding input on the real callback — binding is an explicit connect-panel
   * action against the webhook-recorded row. Only the dev-callback QA path
   * consumes it (its stub id together with `opts.devBindInstallation`).
   */
  installationId: number | null,
  /**
   * First Tree org whose panel kicked off the install, carried in the signed
   * state (codex P1-3). Used to pin the browser back onto that org so the
   * user lands on the panel they started from — not to bind anything. The
   * user MUST be an active admin of it (re-checked here against the live
   * `members` row — the state JWT outlives a membership revoke).
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
    /** Distinguishes acquisition sign-in from an authenticated App install. */
    callbackIntent?: "sign-in" | "install";
    /**
     * DEV-CALLBACK ONLY. When true, the `installationId` stub is bound
     * directly to the resolved org (so a local QA session looks connected
     * without a real webhook). The real `/callback` never sets this — its
     * binding is webhook-driven.
     */
    devBindInstallation?: boolean;
  } = {},
) {
  const { kickoffUserId = null, browserFacing = false, callbackIntent = "sign-in", devBindInstallation = false } = opts;
  const account = await findOrCreateGithubAccount(app.db, profile, oauthTokens);
  const { userId } = account;
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

  if (inviteMatch?.[1] || !targetOrganizationId) {
    let bootstrap: Awaited<ReturnType<typeof completeExternalAccountBootstrap>>;
    try {
      bootstrap = await completeExternalAccountBootstrap(app.db, account, {
        next,
        allowedOrganizationId,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
    } catch (error) {
      if (!(error instanceof OAuthBootstrapError)) throw error;
      if (browserFacing)
        return redirectCallbackError(reply, error.code, next, { callbackIntent, accountCreated: account.created });
      const statusCode = error.code === "invite-invalid" ? 404 : 403;
      return reply.status(statusCode).send({ error: oauthBootstrapErrorMessage(error.code) });
    }
    joinPath = bootstrap.joinPath;
    resolved = true;
    resolvedOrganizationId = bootstrap.organizationId;
    orgPinned = bootstrap.orgPinned;
    next = bootstrap.next;
    if (bootstrap.teamCreated) {
      app.log.info(
        {
          event: "onboarding.team_created",
          provider: "github",
          userId,
          organizationId: bootstrap.organizationId,
          source: "oauth-bootstrap",
        },
        "onboarding funnel: team auto-created at OAuth bootstrap",
      );
    }
  } else {
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
      if (browserFacing)
        return redirectCallbackError(reply, "install-not-admin", next, {
          callbackIntent,
          accountCreated: account.created,
        });
      return reply.status(403).send({ error: "Not an admin of the First Tree organization this installation targets" });
    }
    if (bindAuthorityUserId !== userId) {
      // The install was completed under a DIFFERENT GitHub identity than the
      // admin who kicked it off — the browser's github.com session differs
      // from the First Tree kickoff admin (a second GitHub account, someone
      // else's github.com session in the same browser, …). No bind side
      // effect exists to worry about here (binding is a panel action), but
      // completing the flow would sign the browser in as the foreign
      // identity — replacing the kickoff admin's session in every tab.
      // Surface it as an error instead: install must use the same GitHub
      // account you signed in / started the install with.
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
      return redirectCallbackError(reply, "install-not-verified", next, {
        callbackIntent,
        accountCreated: account.created,
      });
    }
    // No bind happens here: the `installation.created` webhook records the
    // installation (with its requester/installer anchors) and the admin
    // connects it from the panel `next` points back to. This branch only
    // pins the kickoff org so the browser lands on the right team's panel.
    resolved = true;
    resolvedOrganizationId = targetOrganizationId;
    // joinPath stays "returning"; keep caller's `next` (the Settings page)
    // so the panel's poll can surface the just-recorded installation. Pin
    // the org explicitly: this is a deliberate App-install destination, so
    // the SPA must activate the kickoff org even though the join path reads
    // as a returning sign-in — otherwise a concurrent org switch in another
    // tab would land the Settings page on the user's last-used org instead.
    orgPinned = true;
  }

  // Direct installation bind — DEV-CALLBACK ONLY, gated by `devBindInstallation`.
  // The real `/callback` NEVER sets that flag: real binding is an explicit
  // connect-panel action against the row the trusted, HMAC-signed
  // `installation.created` webhook recorded — never the browser-supplied URL
  // id. `dev-callback` passes a stub installation id + the flag so a local
  // QA session looks connected without a real webhook. The flag gate (not just
  // `installationId !== null`) is essential because the real callback DOES
  // still receive a URL `installation_id` — binding it here would reopen the
  // URL-forgery hole.
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

  // NOTE: sign-in performs no installation binding of any kind. Unbound
  // installations (fresh installs, approval-flow installs, disconnected
  // rows) surface on the Settings connect panel, matched to the signed-in
  // user by the trusted `requester_github_id` / `installer_github_id`
  // webhook anchors, and bind only on an explicit connect action there.

  if (!resolved) {
    if (browserFacing)
      return redirectCallbackError(reply, "membership-unresolved", undefined, {
        callbackIntent,
        accountCreated: account.created,
      });
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
    accountCreated: account.created ? "1" : "0",
    callbackIntent,
  };
  if (resolvedOrganizationId) fragmentParams.org = resolvedOrganizationId;
  if (orgPinned) fragmentParams.orgPinned = "1";
  const fragment = new URLSearchParams(fragmentParams).toString();
  app.log.info(
    {
      event: account.created ? "oauth.account_created" : "oauth.account_reused",
      provider: "github",
      userId,
    },
    "OAuth sign-in completed",
  );
  return reply.redirect(`/auth/github/complete#${fragment}`, 302);
}

function oauthBootstrapErrorMessage(code: OAuthBootstrapError["code"]): string {
  if (code === "invite-invalid") return "Invitation not found or no longer valid";
  if (code === "invite-not-allowed") return "Invitation is not allowed on this server";
  return "This server requires an invitation link to join";
}
