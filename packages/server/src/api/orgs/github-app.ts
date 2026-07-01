import {
  type GithubAccountType,
  type GithubAppInstallationOutput,
  githubAppInstallationClaimBodySchema,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authIdentities } from "../../db/schema/auth-identities.js";
import { ForbiddenError, NotFoundError } from "../../errors.js";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import { buildAppInstallUrl, listInstallationRepos } from "../../services/github-app.js";
import {
  bindInstallationToOrg,
  findInstallationByGithubId,
  findInstallationByOrg,
} from "../../services/github-app-installations.js";
import { mintContextTreeInstallationToken } from "../../services/github-app-token.js";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_MAX_AGE_S, signOAuthState } from "../../services/oauth-state.js";
import { buildCookie } from "../auth/oauth-cookie.js";

/**
 * Where the post-install OAuth callback lands the user once the install
 * dialog is done. Default: back on the Settings → GitHub panel so it can
 * re-render with the now-bound installation. The callback resolves the
 * actual destination from the signed state JWT, not from a query param,
 * so this is tamper-proof.
 */
const POST_INSTALL_NEXT = "/settings/github";

/**
 * Internal paths the install flow is allowed to return to. The onboarding
 * flow surfaces the App-install CTA too (the only reliable `installations/new`
 * entry), and wants the user back in setup rather than dumped on Settings.
 * Allowlisted — never reflect a caller-supplied path verbatim into the
 * signed redirect, so a crafted `?next=` can't become an open redirect.
 */
export const ALLOWED_POST_INSTALL_NEXT: ReadonlySet<string> = new Set([
  POST_INSTALL_NEXT,
  "/onboarding",
  // Tiny "connected — you can close this tab" landing: onboarding connect-code
  // installs in a popup and lands the popup here so it can auto-close while the
  // original tab keeps polling.
  "/onboarding/connected",
  // Context tab build entry: its inline connect-code passes the Context page as
  // `next` when the install popup is blocked (the full-page redirect must return
  // to the inline build/repo-pick flow, not Settings — see
  // context-tree-build-entry.tsx). This replaced the removed /build-tree page,
  // whose recovery surface moved onto the Context tab.
  "/context",
]);

/**
 * Resolve the post-install redirect destination from a caller-supplied
 * `?next=`. Anything not on the allowlist falls back to the Settings
 * default — the value is baked into the signed OAuth state and honored by
 * the callback without re-validation, so it must never reflect an arbitrary
 * path (open-redirect / phishing surface). Exported for unit testing.
 */
export function resolvePostInstallNext(requested: string | undefined): string {
  return requested && ALLOWED_POST_INSTALL_NEXT.has(requested) ? requested : POST_INSTALL_NEXT;
}

/**
 * Class B — `/api/v1/orgs/:orgId/github-app-installation`.
 *
 * Read-only admin view of the GitHub App installation bound to this First Tree
 * team. Powers the Settings → Integrations panel. 404 when no install is
 * bound (the panel renders the "Install on GitHub" prompt in that case).
 *
 * Distinct from `/orgs/:orgId/settings/:namespace` because installations
 * aren't editable through the same PUT/DELETE shape — the row's lifecycle
 * is driven by GitHub events (install / uninstall / suspend) and the
 * OAuth callback. The Settings panel surfaces it for visibility but the
 * write path is upstream.
 *
 * Admin-only: the installation block exposes account-level metadata
 * (login, permissions, events) that a regular member doesn't need.
 */
export async function orgGithubAppRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const row = await findInstallationByOrg(app.db, scope.organizationId);
    if (!row) {
      throw new NotFoundError("No GitHub App installation is bound to this team");
    }

    const accountType = row.accountType as GithubAccountType;
    // GitHub's own UI for managing an installation lives at two distinct
    // URLs depending on whether the account is a personal user or an org.
    // We compute both forms here so the panel's "Manage on GitHub" link
    // points at the right place without the client needing to know the rule.
    const manageUrl =
      accountType === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(row.accountLogin)}/settings/installations/${row.installationId}`
        : `https://github.com/settings/installations/${row.installationId}`;

    const out: GithubAppInstallationOutput = {
      installationId: row.installationId,
      accountType,
      accountLogin: row.accountLogin,
      accountGithubId: row.accountGithubId,
      // permissions / events shapes are typed as Record<string, …> /
      // string[] on the row already; pass them through as-is.
      permissions: row.permissions,
      events: row.events,
      suspended: row.suspendedAt !== null,
      manageUrl,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    return out;
  });

  /**
   * GET `/exists` — member-readable boolean "does this team have a GitHub
   * App installation?". The full GET above is admin-only because it exposes
   * installation-id / permissions / events that regular members shouldn't
   * see; this endpoint redacts everything except the bare presence bit so
   * the invitee onboarding path can authoritatively detect the
   * "admin set up the tree but never connected code" failure mode (without
   * which we either block every invitee of a working team — if 403 maps to
   * `missing` — or never trip the warning at all — if 403 maps to
   * `installed`).
   *
   * Returns `{ exists: boolean }`. No 404 path; presence is the whole
   * answer.
   */
  app.get<{ Params: { orgId: string } }>("/exists", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const row = await findInstallationByOrg(app.db, scope.organizationId);
    return { exists: row !== null && row !== undefined };
  });

  /**
   * GET `/repositories` — admin-only list of the repos this team's GitHub
   * App installation can access. Powers the onboarding admin connect-code
   * project picker.
   *
   * Why this instead of the caller's OAuth `/user/repos` (the `/me/github/repos`
   * endpoint): the product is team-by-default, so the picker should offer
   * the team's *org* code, not the admin's unrelated personal repos. The
   * installation's repository set IS exactly that — the repos the App was
   * granted on the bound org account — so personal repos fall out naturally
   * and we only ever list repos the agent can actually reach (no picking a
   * repo the installation can't touch, which would 403 on the first git op).
   *
   * Admin-gated (NOT member-readable like `/exists`): the response is the
   * full installation candidate catalog — every reachable repo's name,
   * clone URL, default branch and private flag — which can include private
   * repos a given member isn't even a GitHub collaborator on. `/exists` is
   * not a precedent (it returns a boolean, not a catalog), and the only
   * consumer is the admin-path connect-code step (`connect-code` is in
   * ADMIN_STEPS only), so least-privilege costs nothing here.
   *
   * Failure shapes (each a distinct `code` so the picker can react):
   *   - no installation bound      → 503 `no_installation` ("connect code first / later")
   *   - installation suspended     → 503 `suspended`
   *   - App not configured server  → 503 `not_configured`
   *   - mint / GitHub upstream blip → 502 `upstream`
   */
  app.get<{ Params: { orgId: string } }>("/repositories", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const row = await findInstallationByOrg(app.db, scope.organizationId);
    const mint = await mintContextTreeInstallationToken(row, app.config.oauth?.githubApp);
    if (!mint.ok) {
      if (mint.reason === "no-installation") {
        return reply
          .status(503)
          .send({ error: "No GitHub App installation is connected for this team yet.", code: "no_installation" });
      }
      if (mint.reason === "suspended") {
        return reply
          .status(503)
          .send({ error: "This team's GitHub App installation is suspended.", code: "suspended" });
      }
      if (mint.reason === "no-app-config") {
        return reply
          .status(503)
          .send({ error: "GitHub App is not configured on this server.", code: "not_configured" });
      }
      // mint-failed — a transient mint/upstream error.
      app.log.warn(
        { organizationId: scope.organizationId, detail: mint.detail },
        "list installation repos: token mint failed",
      );
      return reply.status(502).send({ error: "Couldn't reach GitHub. Try again in a moment.", code: "upstream" });
    }
    try {
      const repos = await listInstallationRepos(mint.token);
      return { repos };
    } catch (err) {
      app.log.warn({ err, organizationId: scope.organizationId }, "list installation repos failed");
      return reply.status(502).send({ error: "Couldn't reach GitHub. Try again in a moment.", code: "upstream" });
    }
  });

  // ── POST-ish helper: build the "Install on GitHub" URL ──────────────
  //
  // Why a server endpoint and not a static link the SPA builds itself:
  //
  //   1. The slug lives in server config (env var), not in any client
  //      bundle — surfacing it would mean shipping it to the browser
  //      anyway, but more importantly the URL has to carry a signed
  //      `state` JWT (CSRF defense) that only the server can mint.
  //   2. We need to set the `oauth_state_nonce` cookie alongside the
  //      JWT — same double-submit defense as `/auth/github/start`. A
  //      static `<a href>` can't do that.
  //   3. The signed state encodes which org the install should bind to
  //      (`targetOrganizationId`) — that decision is the admin caller's
  //      identity, which only the server can authenticate.
  //
  // The SPA fetches this (with its bearer token), gets `{ installUrl }`
  // back plus a `Set-Cookie`, then does `window.location = installUrl`.
  // GitHub shows the install dialog, the user picks repos, GitHub
  // redirects to `/auth/github/callback?code=…&state=…&installation_id=…`.
  // The callback verifies the state cookie and records a per-install pending
  // bind; the trusted `installation.created` webhook performs the actual bind.
  app.get<{ Params: { orgId: string }; Querystring: { next?: string } }>("/install-url", async (request, reply) => {
    // Admin-gated: the resolved scope is the org the install binds to.
    const scope = await requireOrgAdmin(request, app.db);
    const appCfg = app.config.oauth?.githubApp;
    if (!appCfg?.slug) {
      // The App may be configured for sign-in/webhooks but missing the
      // slug needed for the install dialog. 503 (not 404/400) — the
      // operator can fix it by setting one env var; the panel renders a
      // "ask your operator to set FIRST_TREE_GITHUB_APP_SLUG" hint.
      return reply
        .status(503)
        .send({ error: "GitHub App install URL is unavailable — FIRST_TREE_GITHUB_APP_SLUG is not configured." });
    }

    // `targetOrganizationId` rides inside the signed state so the resulting
    // installation binds to *this* org rather than the caller's primary org
    // (codex P1-3) — an admin in org B installing the App must end up bound to
    // org B. `kickoffUserId` rides alongside it so the
    // callback can rest the bind on THIS admin's (re-checked) authority
    // even when the browser's github.com session resolves to a different
    // GitHub identity — the github.com session and the First Tree session
    // are independent, and a mismatch must not strand the install unbound.
    const { token, nonce } = await signOAuthState(
      app.config.secrets.jwtSecret,
      resolvePostInstallNext(request.query.next),
      {
        targetOrganizationId: scope.organizationId,
        kickoffUserId: scope.userId,
      },
    );
    reply.header(
      "Set-Cookie",
      buildCookie({
        name: OAUTH_STATE_COOKIE,
        value: nonce,
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_S,
        secure: process.env.NODE_ENV === "production",
      }),
    );

    // No DB write here: `installation_id` doesn't exist until the user
    // completes the install. The signed state carries `targetOrganizationId`
    // + `kickoffUserId` to the callback, which records the per-install pending
    // bind (keyed by the concrete `installation_id`) that the trusted
    // `installation.created` webhook then completes.
    return { installUrl: buildAppInstallUrl({ appSlug: appCfg.slug, state: token }) };
  });

  // ── Manual install claim ────────────────────────────────────────────
  //
  // Recovery hatch for an installation row that ended up unbound (e.g. the
  // `installation.created` webhook arrived without a matching pending bind, or
  // the kickoff callback never completed). Normal binding is webhook-driven;
  // this is the manual fallback.
  //
  // ⚠ This endpoint is **API-only** — there is no Settings UI that calls
  // it yet. The orphan-list endpoint and a per-install `Claim install` button
  // are tracked in #318; until then, recovery requires POSTing here directly.
  //
  // Authorization: being a First Tree org admin isn't sufficient — the
  // browser-supplied installation id isn't a secret. The caller may claim
  // ONLY an installation THEY installed, matched against the trusted
  // `installer_github_id` (the `installation.created` webhook `sender`; GitHub
  // only lets a user install on an account they administer). This replaces the
  // removed `verifyUserCanAdministerInstallation` probe on this path. The row
  // (and its `installer_github_id`) is written by the webhook; 404 here means
  // there's nothing to claim.
  app.post<{ Params: { orgId: string }; Body: unknown }>("/claim", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const { installationId } = githubAppInstallationClaimBodySchema.parse(request.body);

    const installRow = await findInstallationByGithubId(app.db, installationId);
    if (!installRow) {
      throw new NotFoundError(`Installation ${installationId} not found`);
    }

    // Anti-forgery (no GitHub round-trip, no `organization:members:read`):
    // the caller may claim ONLY an installation they installed themselves.
    // `installer_github_id` is the `sender` from the trusted, HMAC-signed
    // `installation.created` webhook; GitHub only lets a user install on an
    // account they administer, so matching it to the caller's own GitHub id
    // proves both "the caller installed this" and "the caller administers
    // the installed account" — the guarantee the removed
    // `verifyUserCanAdministerInstallation` probe used to provide.
    const [identity] = await app.db
      .select({ identifier: authIdentities.identifier })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, scope.userId), eq(authIdentities.provider, "github")))
      .limit(1);
    const userGithubId = identity?.identifier ? Number(identity.identifier) : Number.NaN;
    if (Number.isNaN(userGithubId)) {
      throw new ForbiddenError("No GitHub identity on file — sign in with GitHub again before claiming an install");
    }
    if (installRow.installerGithubId === null) {
      // Row predates the trusted installer id (or wasn't created via the
      // `installation.created` webhook). Reinstall from the account owner
      // to mint it.
      throw new ForbiddenError(
        "This installation has no recorded installer — reinstall the GitHub App from the account owner to claim it.",
      );
    }
    if (installRow.installerGithubId !== userGithubId) {
      throw new ForbiddenError("You didn't install this GitHub App installation, so you can't claim it.");
    }

    // bindInstallationToOrg throws NotFoundError (no such install row) →
    // 404, ConflictError (install already bound elsewhere, or this org
    // already has a different install) → 409.
    await bindInstallationToOrg(app.db, installationId, scope.organizationId);
    return { installationId, organizationId: scope.organizationId, bound: true };
  });
}
