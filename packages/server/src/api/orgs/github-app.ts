import type { GithubAccountType, GithubAppInstallationOutput } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../errors.js";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { findInstallationByOrg } from "../../services/github-app-installations.js";

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
}
