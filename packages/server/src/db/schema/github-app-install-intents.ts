import { bigint, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Pending GitHub App install intents — the trusted correlation between
 * "a First Tree admin kicked off an install for org T" and the later,
 * out-of-band `installation.created` webhook that actually creates the
 * installation.
 *
 * Why this table exists (anti-forgery, see `system/cloud/github/github-app.md`):
 * the browser-supplied URL `installation_id` on the OAuth callback is not a
 * trust anchor (not signed, address-bar-forgeable). Binding is therefore
 * driven by the HMAC-signed `installation.created` webhook, whose `sender`
 * is the GitHub-authenticated installer. But the webhook alone doesn't know
 * *which* First Tree org to bind to. This row carries that intent:
 *
 *   1. `GET /orgs/:orgId/github-app-installation/install-url` (admin-gated)
 *      records `{ installerGithubId = kickoff admin's GitHub id,
 *      targetOrganizationId }` before redirecting to GitHub.
 *   2. The `installation.created` webhook looks the intent up by
 *      `installerGithubId == sender.id` and binds the new installation to
 *      `targetOrganizationId`, then consumes the intent.
 *
 * Because the lookup key is the webhook `sender` (GitHub-authenticated) and
 * intents are only mintable by an authenticated First Tree admin of the
 * target org, "installer == kickoff admin" and "installer administers the
 * installed account" both hold without any `organization:members:read`
 * probe.
 *
 * One active intent per installer (UNIQUE on `installer_github_id`,
 * last-write-wins): a user re-initiating install for a different org
 * overwrites the stale intent. `expires_at` bounds the window so a stale
 * intent can't bind an unrelated later install.
 */
export const githubAppInstallIntents = pgTable(
  "github_app_install_intents",
  {
    /** UUID v7 primary key, app-generated. */
    id: text("id").primaryKey(),
    /**
     * GitHub numeric id of the First Tree admin who kicked off the install
     * (resolved from `auth_identities` at mint time). Matched against the
     * `installation.created` webhook `sender.id` to bind.
     */
    installerGithubId: bigint("installer_github_id", { mode: "number" }).notNull(),
    /** First Tree org the resulting installation should bind to. */
    targetOrganizationId: text("target_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Freshness bound — intents past this are ignored and swept. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One active intent per installer — a new kickoff UPSERTs (last-wins).
    uniqueIndex("uq_github_app_install_intents_installer").on(table.installerGithubId),
    // Sweep expired intents efficiently.
    index("idx_github_app_install_intents_expires").on(table.expiresAt),
  ],
);
