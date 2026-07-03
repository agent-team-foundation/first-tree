import { bigint, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Pending GitHub App install **requests** — the approval-flow counterpart to
 * `github_app_install_intents` (see `system/cloud/github/github-app.md`).
 *
 * Context: when a First Tree admin who is NOT a GitHub owner of the target
 * account initiates the install, GitHub cannot install directly — it records
 * a request and emails the org's owners. At that point there is **no
 * `installation_id`** yet, so the per-install pending bind (keyed by
 * `installation_id`) cannot be recorded. GitHub also provides no correlation
 * handle at approval time (the `installation.created` `sender` is the
 * approver, not the requester). So we capture the request here, keyed by the
 * **initiator** (the kickoff admin — known from our own signed state, which
 * we mint at `/install-url`), and complete the bind when the initiator
 * returns after approval.
 *
 * Keyed by `(initiator_github_id, target_organization_id)` rather than by
 * installation, because at request time no installation exists yet. One active
 * request per (initiator, target Hub org), last-write-wins on re-kick. The key
 * is deliberately NOT `initiator_github_id` alone: a single initiator can have
 * concurrent outstanding requests to different Hub orgs, and collapsing them to
 * one row would let a later request silently overwrite an earlier one — so an
 * approval for the earlier installation would bind to the later request's org
 * (cross-org webhook routing). Keeping a row per target org lets the completion
 * path DETECT that ambiguity (>1 fresh request for an initiator ⇒ it cannot
 * tell which org an approval belongs to) and refuse to auto-bind instead of
 * mis-binding. `expires_at` bounds staleness.
 *
 * Authorization to complete a bind from this record is "the caller is the
 * initiator who requested it" (their GitHub id + First Tree admin of the
 * target org) — NOT a current-GitHub-admin check, since the initiator is a
 * member, not an owner. The GitHub-side authorization is the owner's approval
 * (which is what created the installation).
 */
export const githubAppInstallRequests = pgTable(
  "github_app_install_requests",
  {
    /** UUID v7 primary key, app-generated. */
    id: text("id").primaryKey(),
    /**
     * GitHub numeric id of the First Tree admin who initiated the install
     * (the kickoff user, resolved from `auth_identities` at capture time).
     * The completion path matches this against the returning caller.
     */
    initiatorGithubId: bigint("initiator_github_id", { mode: "number" }).notNull(),
    /** First Tree org the resulting installation should bind to. */
    targetOrganizationId: text("target_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** First Tree user id of the initiator (kickoff admin), for the completion authz. */
    kickoffUserId: text("kickoff_user_id").notNull(),
    /** Freshness bound — requests past this are ignored and swept. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One active request per (initiator, target org) — a re-kick for the same
    // pair UPSERTs (last-wins); a different target org adds a distinct row so
    // the completion path can detect the ambiguous multi-request case.
    uniqueIndex("uq_github_app_install_requests_initiator_org").on(table.initiatorGithubId, table.targetOrganizationId),
    // Lookup + ambiguity count by initiator.
    index("idx_github_app_install_requests_initiator").on(table.initiatorGithubId),
    index("idx_github_app_install_requests_expires").on(table.expiresAt),
  ],
);
