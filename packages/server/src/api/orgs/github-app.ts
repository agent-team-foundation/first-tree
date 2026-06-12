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
import { getStoredGithubAccessToken } from "../../services/auth-identity.js";
import {
  buildAppInstallUrl,
  GithubAppApiError,
  listInstallationRepos,
  verifyUserCanAdministerInstallation,
} from "../../services/github-app.js";
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
  // redirects to `/auth/github/callback?code=…&state=…&installation_id=…`,
  // and the callback verifies the state cookie + binds the install.
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

    // `targetOrganizationId` rides inside the signed state so the OAuth
    // callback binds the install to *this* org rather than the caller's
    // primary org (codex P1-3) — an admin in org B installing the App must
    // end up bound to org B. `kickoffUserId` rides alongside it so the
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
    return { installUrl: buildAppInstallUrl({ appSlug: appCfg.slug, state: token }) };
  });

  // ── Manual install claim ────────────────────────────────────────────
  //
  // Recovery hatch for an installation row that ended up unbound — the
  // OAuth callback's auto-reclaim sweep handles the single-orphan case at
  // sign-in, but bails when there are several (or when the install is on
  // an org account, where "the user is an org admin" isn't a strong enough
  // basis to auto-claim).
  //
  // ⚠ This endpoint is **API-only** — there is no Settings UI that calls
  // it yet. The orphan-list endpoint and the `Claim install` button per
  // orphan are tracked in #318. Until #318 ships, multi-orphan recovery
  // requires the operator to POST to this endpoint directly.
  //
  // Authorization mirrors the OAuth callback's `installation_id` check:
  // being an admin of the target First Tree org isn't sufficient — installation
  // IDs aren't secrets, so we also confirm the caller can actually
  // **administer** the install on GitHub. Per-install rules:
  //   - User-type: caller's GitHub ID must equal the install account's
  //     GitHub ID (only the account owner counts).
  //   - Org-type: `GET /user/memberships/orgs/{login}` must return
  //     `state=active, role=admin`. Plain org membership is NOT enough —
  //     that's what made the legacy `/user/installations` primitive
  //     forgeable (it surfaced any install the user had read access to).
  //
  // Account metadata comes from the existing DB row (UPSERTed by the
  // webhook or the OAuth callback). 404 here means there's nothing to
  // claim at all; the bind step never runs.
  app.post<{ Params: { orgId: string }; Body: unknown }>("/claim", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const { installationId } = githubAppInstallationClaimBodySchema.parse(request.body);

    const installRow = await findInstallationByGithubId(app.db, installationId);
    if (!installRow) {
      throw new NotFoundError(`Installation ${installationId} not found`);
    }

    const githubToken = await getStoredGithubAccessToken(app.db, scope.userId, app.config.secrets.encryptionKey);
    if (!githubToken) {
      throw new ForbiddenError("No GitHub access token on file — sign in with GitHub again before claiming an install");
    }

    // Same row `getStoredGithubAccessToken` just verified — pull the
    // caller's numeric GitHub ID off `auth_identities.identifier`
    // (written by the OAuth callback as `String(profile.githubId)`) so
    // the User-type comparison has something to match against.
    const [identity] = await app.db
      .select({ identifier: authIdentities.identifier })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, scope.userId), eq(authIdentities.provider, "github")))
      .limit(1);
    const userGithubId = Number(identity?.identifier);

    let canAdminister: boolean;
    try {
      canAdminister = await verifyUserCanAdministerInstallation(githubToken, userGithubId, {
        accountType: installRow.accountType as "User" | "Organization",
        accountLogin: installRow.accountLogin,
        accountGithubId: installRow.accountGithubId,
      });
    } catch (err) {
      const status = err instanceof GithubAppApiError ? err.status : 0;
      if (status === 401) {
        throw new ForbiddenError("Your GitHub session has expired — sign in with GitHub again, then retry the claim");
      }
      // Upstream hiccup — surface as 403 so the caller retries rather
      // than treating a transient GitHub outage as a hard failure.
      app.log.warn({ err, installationId, userId: scope.userId }, "claim: admin proof check failed");
      throw new ForbiddenError("Couldn't verify GitHub access for this installation — try again in a moment");
    }
    if (!canAdminister) {
      throw new ForbiddenError("You don't administer this installation on GitHub");
    }

    // bindInstallationToOrg throws NotFoundError (no such install row) →
    // 404, ConflictError (install already bound elsewhere, or this org
    // already has a different install) → 409.
    await bindInstallationToOrg(app.db, installationId, scope.organizationId);
    return { installationId, organizationId: scope.organizationId, bound: true };
  });
}
