import type {
  GithubAccountType,
  GithubAppInstallationEvents,
  GithubAppInstallationPermissions,
} from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * GitHub App installation records — one row per (GitHub account → First Tree team)
 * binding. Replaces the per-repo OAuth + webhook-secret model that lived in
 * `organization_settings.github_integration.webhookSecretCipher`.
 *
 * One installation simultaneously unlocks three capabilities (see the GitHub
 * App design in the First Tree context tree: `system/cloud/github/github-app.md`):
 *   1. User OAuth (user-to-server access + refresh tokens) — persisted on
 *      `auth_identities.metadata` for the signing-in user, not here.
 *   2. Webhook stream — `installation_id` resolves the inbound webhook to
 *      the bound First Tree org by joining on this table.
 *   3. Installation token (server-to-server) — minted on demand from the
 *      App private key; not persisted (1h TTL, cheap to re-issue).
 *
 * The (GitHub account ↔ First Tree team) binding is 1:1 (D2 / §8 Q1). The
 * `hub_organization_id` UNIQUE constraint enforces that; the column is
 * nullable solely to accommodate the install-callback handler inserting
 * the row before the owning First Tree team exists (fresh-signup flow). Once a
 * binding exists it never moves — re-installing the App on the same GitHub
 * account UPDATEs this row by `installation_id`.
 *
 * ON DELETE SET NULL on `hub_organization_id` rather than CASCADE because
 * the GitHub-side installation still exists upstream when a First Tree team is
 * deleted — keeping the row lets a future re-binding flow recover without
 * a re-install dance.
 */
export const githubAppInstallations = pgTable(
  "github_app_installations",
  {
    /** UUID v7 primary key, app-generated. */
    id: text("id").primaryKey(),
    /**
     * GitHub-issued installation ID. Stable for the lifetime of the
     * installation; survives uninstall + re-install on the same account if
     * the user re-uses the same App, otherwise a fresh ID is issued.
     * BIGINT because GitHub assigns 64-bit IDs; `mode: "number"` is safe
     * for the foreseeable future (current IDs are ~8 digits, far below
     * Number.MAX_SAFE_INTEGER).
     */
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    /** "User" (personal install) | "Organization" (org install). */
    accountType: text("account_type").$type<GithubAccountType>().notNull(),
    /**
     * GitHub login slug, e.g. "octocat". Mutable — GitHub permits account
     * renames. Refreshed on every webhook that carries the account block.
     */
    accountLogin: text("account_login").notNull(),
    /**
     * GitHub numeric id of the account. Immutable for the account's
     * lifetime; survives login renames. Use this — not `accountLogin` —
     * as the stable identifier when reconciling with GitHub state.
     */
    accountGithubId: bigint("account_github_id", { mode: "number" }).notNull(),
    /**
     * First Tree org this installation is bound to (1:1, see D2 / §8 Q1).
     * Nullable to allow inserting the row in the install callback before
     * the owning First Tree team is provisioned. Once bound, the value never
     * changes — there is no "rebind" flow.
     */
    hubOrganizationId: text("hub_organization_id").references(() => organizations.id, { onDelete: "set null" }),
    /**
     * Granted permissions snapshot, e.g.
     *   {contents: "write", pull_requests: "write", issues: "read", ...}
     * Refreshed on `installation` / `installation_repositories` webhooks.
     * Keys are free-form because GitHub adds new permission names over
     * time; the type is enforced at the service layer via the shared
     * `githubAppInstallationPermissionsSchema`.
     */
    permissions: jsonb("permissions").$type<GithubAppInstallationPermissions>().notNull(),
    /**
     * Subscribed event-name list, e.g. ["issues", "pull_request", "push"].
     * Mirrors `installation.events` on webhook payloads.
     */
    events: jsonb("events").$type<GithubAppInstallationEvents>().notNull(),
    /**
     * Set when GitHub fires `installation: suspend`; cleared on
     * `installation: unsuspend`. While non-null, webhook delivery is
     * paused upstream and installation-token requests are refused — First Tree
     * code should treat the binding as inactive.
     */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Installation ID is GitHub's stable primary key — UNIQUE so re-install
    // webhooks UPSERT by it instead of creating duplicate rows.
    uniqueIndex("uq_github_app_installations_installation_id").on(table.installationId),
    // 1:1 binding enforcement (D2 / §8 Q1). Postgres treats multiple NULLs
    // as distinct by default, so rows pending org-binding don't collide.
    uniqueIndex("uq_github_app_installations_hub_org").on(table.hubOrganizationId),
    // Lookup by account id when resolving webhooks that name only the
    // account block (rare, but happens for account-rename events).
    index("idx_github_app_installations_account").on(table.accountGithubId),
    // Defense-in-depth: the Drizzle column type narrows to the union but
    // a manual INSERT bypassing the ORM would otherwise be able to write
    // arbitrary strings. Mirrors how auth_identities pins credential_type
    // values via a CHECK in the DB.
    check("ck_github_app_installations_account_type", sql`${table.accountType} IN ('User', 'Organization')`),
  ],
);
