import {
  type GithubAccountType,
  type GithubAppConnectPanelInstallation,
  type GithubAppConnectPanelOutput,
  type GithubAppInstallationOutput,
  githubAppConnectBodySchema,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../db/connection.js";
import { authIdentities } from "../../db/schema/auth-identities.js";
import { NotFoundError } from "../../errors.js";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import { buildAppInstallUrl, listInstallationRepos } from "../../services/github-app.js";
import {
  connectInstallationToOrg,
  disconnectInstallationFromOrg,
  findInstallationByOrg,
  listConnectPanelInstallations,
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
 * Read-only member view of the GitHub App installation bound to this First Tree
 * team. Powers the Settings → GitHub panel. 404 when no install is
 * bound (the panel renders the "Install on GitHub" prompt in that case).
 *
 * Distinct from `/orgs/:orgId/settings/:namespace` because installations
 * aren't editable through the same PUT/DELETE shape — the row's lifecycle
 * is driven by GitHub events (install / uninstall / suspend) and the
 * OAuth callback. The Settings panel surfaces it for visibility but the
 * write path is upstream.
 *
 * Member-readable: Settings → GitHub is the source repo + connection status
 * surface for the whole team. Mutations and installation catalog APIs below
 * remain admin-only.
 */
export async function orgGithubAppRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
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
   * App installation?". The full GET above is also member-readable for
   * Settings → GitHub, while this endpoint keeps a narrower redacted shape
   * for callers that only need a presence bit. It lets the invitee onboarding
   * path authoritatively detect the
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
  //   3. The signed state encodes which org's panel kicked the install
  //      off (`targetOrganizationId`) — that fact is the admin caller's
  //      identity, which only the server can authenticate.
  //
  // The SPA fetches this (with its bearer token), gets `{ installUrl }`
  // back plus a `Set-Cookie`, then does `window.location = installUrl`.
  // GitHub shows the install dialog, the user picks repos, GitHub
  // redirects to `/auth/github/callback?code=…&state=…&installation_id=…`
  // (or without `code` when the install is parked for owner approval).
  // The callback only lands the browser back on the kickoff org's panel;
  // the trusted `installation.created` webhook records the installation
  // unbound, and connecting it is an explicit panel action.
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

    // `targetOrganizationId` rides inside the signed state so the callback
    // can land the browser back on *this* org's panel rather than the
    // caller's primary org (codex P1-3). `kickoffUserId` rides alongside it
    // so the callback can detect the browser's github.com session resolving
    // to a DIFFERENT identity than the kickoff admin — the github.com
    // session and the First Tree session are independent, and a mismatch
    // must not silently swap the signed-in user.
    const { token, nonce } = await signOAuthState(
      app.config.secrets.jwtSecret,
      resolvePostInstallNext(request.query.next),
      {
        intent: "install",
        provider: "github",
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
    // completes the install, and even then the webhook records it unbound —
    // the signed state only routes the browser back to this org's panel,
    // where connecting the recorded installation is an explicit action.
    return { installUrl: buildAppInstallUrl({ appSlug: appCfg.slug, state: token }) };
  });

  // ── Connect panel ────────────────────────────────────────────────────
  //
  // The unified connect model: the `installation.created` webhook records
  // every installation UNBOUND (with the GitHub-verified requester and
  // installer ids), and a team admin explicitly connects one from this
  // panel. The target team is the team whose panel the caller is on —
  // that click is what decides the binding, so there is no server-side
  // install intent and no auto-bind.
  //
  // Authorization for connect = First Tree admin of this team (route) +
  // the caller's GitHub id equals the installation's requester or
  // installer (service). Both facts are already in our DB — the panel
  // endpoints make no GitHub API call and need no GitHub permission.

  /**
   * GET `/connect-panel` — the panel's row set for this caller + team:
   * every installation whose webhook-verified requester or installer is
   * the caller's GitHub id, PLUS the installation bound to this team
   * regardless of association (the binding is the team's resource — any
   * team admin must see it and reach its Disconnect, even when the
   * original requester/installer left or the caller has no GitHub
   * identity). Rows are annotated relative to THIS team as `connectable`
   * / `connected-here` / `connected-elsewhere` (the latter carrying the
   * holding team's display name). Installations arrive asynchronously
   * (owner approval, installs made directly on GitHub), so the panel
   * polls this endpoint while open.
   *
   * Admin-gated like the other panel actions — the list exposes
   * account-level install metadata and exists only to drive
   * connect/disconnect.
   */
  app.get<{ Params: { orgId: string } }>("/connect-panel", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const callerGithubId = await resolveCallerGithubId(app.db, scope.userId);
    const rows = await listConnectPanelInstallations(app.db, {
      githubUserId: callerGithubId,
      hubOrganizationId: scope.organizationId,
    });
    const installations: GithubAppConnectPanelInstallation[] = rows.map((row) => ({
      installationId: row.installationId,
      accountType: row.accountType as GithubAccountType,
      accountLogin: row.accountLogin,
      accountGithubId: row.accountGithubId,
      suspended: row.suspendedAt !== null,
      status:
        row.hubOrganizationId === null
          ? "connectable"
          : row.hubOrganizationId === scope.organizationId
            ? "connected-here"
            : "connected-elsewhere",
      connectedTeamName:
        row.hubOrganizationId !== null && row.hubOrganizationId !== scope.organizationId ? row.connectedTeamName : null,
      createdAt: row.createdAt.toISOString(),
    }));
    const out: GithubAppConnectPanelOutput = { installations };
    return out;
  });

  /**
   * POST `/connect` — bind an installation to this team. Service-layer
   * errors map to the panel's affordances: 404 unknown installation, 403
   * not the caller's installation (or no GitHub identity on file), 409
   * 1:1 conflict (installation already connected to another team, or this
   * team already holds a different installation).
   */
  app.post<{ Params: { orgId: string }; Body: unknown }>("/connect", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const { installationId } = githubAppConnectBodySchema.parse(request.body);
    const callerGithubId = await resolveCallerGithubId(app.db, scope.userId);
    await connectInstallationToOrg(app.db, {
      installationId,
      hubOrganizationId: scope.organizationId,
      callerGithubId,
    });
    return { installationId, organizationId: scope.organizationId, connected: true };
  });

  /**
   * POST `/disconnect` — clear this team's binding. The GitHub-side
   * installation is untouched (no uninstall), so the row survives and can
   * be reconnected from any panel later. No body: the 1:1 rule means "the
   * team's binding" is unambiguous. 404 when nothing is bound. Plain team
   * admin suffices — the binding is the team's own resource, so no
   * requester/installer match is required to release it.
   */
  app.post<{ Params: { orgId: string } }>("/disconnect", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const row = await disconnectInstallationFromOrg(app.db, scope.organizationId);
    return { installationId: row.installationId, organizationId: scope.organizationId, disconnected: true };
  });
}

/**
 * The caller's numeric GitHub id off `auth_identities.identifier` (written
 * by the OAuth callback as `String(profile.githubId)`), or null when the
 * user has no GitHub identity on file. This is the login-authenticated
 * half of the connect authorization; the webhook-recorded
 * requester/installer ids are the other half.
 */
async function resolveCallerGithubId(db: Database, userId: string): Promise<number | null> {
  const [identity] = await db
    .select({ identifier: authIdentities.identifier })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "github")))
    .limit(1);
  if (!identity) return null;
  const githubId = Number(identity.identifier);
  return Number.isFinite(githubId) ? githubId : null;
}
