import { bigint, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Per-installation pending binds — the trusted, **per-install** correlation
 * between an admin-initiated install kickoff and the out-of-band
 * `installation.created` webhook that actually creates the installation
 * (see `system/cloud/github/github-app.md`).
 *
 * Why keyed by `installation_id` (not by installer): the binding key must be
 * the *specific installation*, not just "some install by this GitHub user".
 * Otherwise a single GitHub user with a stale/concurrent install dialog (or
 * who installs on a second account) could have an unrelated installation
 * bound to the wrong team within the intent TTL. The correlation therefore:
 *
 *   1. `/install-url` (admin-gated) mints a signed state carrying
 *      `targetOrganizationId` + `kickoffUserId` (no DB write).
 *   2. The **callback** — which holds the concrete `installation_id` (URL) and
 *      the signed kickoff — records THIS row: `installation_id` →
 *      `{ target_organization_id, kickoff_user_id, kickoff_github_id }`.
 *   3. Binding happens **only** once the HMAC-signed `installation.created`
 *      webhook proves the installation's `sender` (installer) equals
 *      `kickoff_github_id` AND the kickoff user is still an active admin of
 *      the target org (`completeInstallBind`). The browser-supplied URL
 *      `installation_id` is thus only a *correlation handle*; it is never a
 *      binding authority on its own.
 *
 * `expires_at` bounds the window. UNIQUE on `installation_id` — one pending
 * bind per installation (re-callback for the same install is an idempotent
 * refresh).
 */
export const githubAppInstallIntents = pgTable(
  "github_app_install_intents",
  {
    /** UUID v7 primary key, app-generated. */
    id: text("id").primaryKey(),
    /**
     * GitHub-issued installation id this pending bind is for (the correlation
     * handle from the callback URL). BIGINT to match `github_app_installations`.
     */
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    /** First Tree org the installation should bind to (from the signed kickoff state). */
    targetOrganizationId: text("target_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * First Tree user who kicked off the install (from the signed state).
     * Re-checked for active admin of `target_organization_id` at bind time —
     * defends against the admin being downgraded during the intent TTL.
     */
    kickoffUserId: text("kickoff_user_id").notNull(),
    /**
     * The kickoff user's GitHub numeric id (resolved at callback time).
     * Bind proceeds only when the `installation.created` webhook `sender`
     * equals this — i.e. the installer is the kickoff admin.
     */
    kickoffGithubId: bigint("kickoff_github_id", { mode: "number" }).notNull(),
    /** Freshness bound — pending binds past this are ignored and swept. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One pending bind per installation — the callback UPSERTs (idempotent
    // refresh if the same install re-hits the callback).
    uniqueIndex("uq_github_app_install_intents_installation").on(table.installationId),
    // Sweep expired pending binds efficiently.
    index("idx_github_app_install_intents_expires").on(table.expiresAt),
  ],
);
