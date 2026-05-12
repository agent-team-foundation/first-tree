import type { GithubAccountType, GithubAppInstallationOutput } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../errors.js";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { buildAppInstallUrl } from "../../services/github-app.js";
import { findInstallationByOrg } from "../../services/github-app-installations.js";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_MAX_AGE_S, signOAuthState } from "../../services/oauth-state.js";
import { buildCookie } from "../auth/oauth-cookie.js";

/**
 * Where the post-install OAuth callback lands the user once the install
 * dialog is done — back on the Settings → GitHub panel so it can
 * re-render with the now-bound installation. The callback resolves the
 * actual destination from the signed state JWT, not from a query param,
 * so this is tamper-proof.
 */
const POST_INSTALL_NEXT = "/settings/github";

/**
 * Class B — `/api/v1/orgs/:orgId/github-app-installation`.
 *
 * Read-only admin view of the GitHub App installation bound to this Hub
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
 * Mirrors the readPolicy="admin" choice for `github_integration` in the
 * legacy settings.
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
  // redirects to `/auth/github/callback?code=…&state=…&installation_id=…`,
  // and the callback verifies the state cookie + binds the install.
  app.get<{ Params: { orgId: string } }>("/install-url", async (request, reply) => {
    // Admin-gated: the resolved scope is the org the install binds to.
    const scope = await requireOrgAdmin(request, app.db);
    const appCfg = app.config.oauth?.githubApp;
    if (!appCfg?.slug) {
      // The App may be configured for sign-in/webhooks but missing the
      // slug needed for the install dialog. 503 (not 404/400) — the
      // operator can fix it by setting one env var; the panel renders a
      // "ask your operator to set FIRST_TREE_HUB_GITHUB_APP_SLUG" hint.
      return reply
        .status(503)
        .send({ error: "GitHub App install URL is unavailable — FIRST_TREE_HUB_GITHUB_APP_SLUG is not configured." });
    }

    // `targetOrganizationId` rides inside the signed state so the OAuth
    // callback binds the install to *this* org rather than the caller's
    // primary org (codex P1-3) — an admin in org B installing the App must
    // end up bound to org B. The callback re-checks the caller is still an
    // admin of that org before honoring it.
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, POST_INSTALL_NEXT, {
      targetOrganizationId: scope.organizationId,
    });
    reply.header(
      "Set-Cookie",
      buildCookie({
        name: OAUTH_STATE_COOKIE,
        value: nonce,
        maxAge: OAUTH_STATE_COOKIE_MAX_AGE_S,
        secure: process.env.NODE_ENV === "production",
      }),
    );
    return { installUrl: buildAppInstallUrl({ appSlug: appCfg.slug, state: token }) };
  });
}
