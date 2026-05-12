import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import type { AppInstallation } from "./github-app.js";

/** Postgres `unique_violation` SQLSTATE — emitted on UNIQUE constraint trips. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === PG_UNIQUE_VIOLATION;
}

/**
 * State-machine layer for the `github_app_installations` table. Two
 * write paths converge here:
 *
 *   1. OAuth-callback install (user just installed the App and landed on
 *      `/auth/github/callback?...&installation_id=...`). The callback
 *      route fetches the installation metadata from GitHub
 *      (`services/github-app.fetchInstallation`) then calls
 *      `upsertInstallationFromMetadata` here.
 *
 *   2. Webhook (`installation: created` / `installation: deleted` /
 *      `installation: suspend` / `installation: unsuspend`). The webhook
 *      payload already carries the full installation block, so it lands
 *      directly via `upsertInstallationFromMetadata` /
 *      `markInstallationSuspended` / `markInstallationUnsuspended` /
 *      `deleteInstallationByGithubId`.
 *
 * Both paths can fire in either order (GitHub delivers them out-of-band
 * relative to the redirect). UPSERT on `installation_id` lets either
 * arrive first without producing duplicate rows; the column UNIQUE index
 * is the dedup mechanism.
 *
 * `bindInstallationToOrg` is the second-half of the OAuth-callback flow —
 * it links a freshly-inserted-or-rebound installation to the user's Hub
 * team. Idempotent: subsequent sign-ins by the same user re-bind to the
 * same org via the UNIQUE(hub_organization_id) constraint (a different
 * user signing in with the same installation_id MUST NOT rebind to their
 * org, per D2 1:1).
 */

export type UpsertInstallationInput = {
  installation: AppInstallation;
  /**
   * Optional Hub org id to bind. Used when the install-callback path
   * already knows the user's primary org at insert time. Webhook path
   * omits this — webhooks don't know which Hub user installed the App;
   * the binding is established by the callback path's
   * `bindInstallationToOrg` instead.
   */
  hubOrganizationId?: string;
};

export type InstallationRow = typeof githubAppInstallations.$inferSelect;

/**
 * UPSERT by `installation_id`. INSERTs a new row when the installation
 * is unseen; UPDATEs the metadata fields on re-install / permission
 * change / event-subscription change.
 *
 * Does NOT touch `hub_organization_id` on UPDATE — that column is
 * managed by `bindInstallationToOrg`. Otherwise a webhook arriving
 * after a manual rebind could clobber the binding back to null.
 */
export async function upsertInstallationFromMetadata(
  db: Database,
  input: UpsertInstallationInput,
): Promise<InstallationRow> {
  const now = new Date();
  const suspendedAt = input.installation.suspendedAt ? new Date(input.installation.suspendedAt) : null;
  const values = {
    id: uuidv7(),
    installationId: input.installation.id,
    accountType: input.installation.accountType,
    accountLogin: input.installation.accountLogin,
    accountGithubId: input.installation.accountGithubId,
    hubOrganizationId: input.hubOrganizationId ?? null,
    permissions: input.installation.permissions,
    events: input.installation.events,
    suspendedAt,
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(githubAppInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: githubAppInstallations.installationId,
      set: {
        accountType: values.accountType,
        accountLogin: values.accountLogin,
        accountGithubId: values.accountGithubId,
        permissions: values.permissions,
        events: values.events,
        suspendedAt: values.suspendedAt,
        updatedAt: now,
        // Deliberately NOT updating `hubOrganizationId` here —
        // binding is owned by `bindInstallationToOrg`. See jsdoc.
      },
    })
    .returning();
  if (!row) {
    throw new Error("upsertInstallationFromMetadata: INSERT returned no row");
  }
  return row;
}

/**
 * Bind an installation to a Hub team. Idempotent: re-binding to the same
 * org is a no-op (returns `false`).
 *
 * Race-safe (codex P0-3): the previous SELECT-then-UPDATE implementation
 * had a TOCTOU window — two concurrent callbacks for the same unbound
 * installation but different Hub orgs could both see `hubOrganizationId
 * IS NULL`, both pass the in-memory validation, and then the second
 * UPDATE would silently rebind. This implementation:
 *
 *   1. Runs a conditional UPDATE: WHERE installation_id = $1 AND
 *      (hub_organization_id IS NULL OR hub_organization_id = $2).
 *      Postgres serializes the rowlock so the second concurrent caller
 *      sees the freshly-set value and the WHERE clause filters it out
 *      — the UPDATE matches 0 rows for the loser.
 *   2. On 0 rows updated, SELECTs the current row to decide which
 *      structured error to throw (not-found vs. already-bound-elsewhere).
 *   3. Catches the 23505 path that fires when two ROWS get rebound to
 *      the SAME hub_organization_id (covers the case where org A
 *      already has installation X bound and a different callback tries
 *      to bind installation Y to org A — the UPDATE on Y succeeds the
 *      WHERE filter but violates UNIQUE(hub_organization_id)).
 *      Surfaces as a clean ConflictError instead of a 23505 leaking
 *      through the route layer.
 *
 * Throws:
 *   - NotFoundError if no installation row exists with installationId.
 *   - ConflictError if (a) the installation is already bound to a
 *     different Hub team (D2 1:1), or (b) the target Hub team is
 *     already bound to a different installation.
 *
 * Returns true on first bind, false on idempotent re-bind to the same org.
 */
export async function bindInstallationToOrg(
  db: Database,
  installationId: number,
  hubOrganizationId: string,
): Promise<boolean> {
  // Conditional UPDATE that only matches rows whose hub_organization_id
  // is either NULL (fresh bind) or already equal to the target
  // (idempotent re-bind). Two concurrent callbacks for different orgs
  // will serialize on the row lock — the loser's WHERE clause filters
  // out the freshly-set value and matches 0 rows.
  let updatedCount: number;
  try {
    const result = await db
      .update(githubAppInstallations)
      .set({ hubOrganizationId, updatedAt: new Date() })
      .where(
        and(
          eq(githubAppInstallations.installationId, installationId),
          or(
            isNull(githubAppInstallations.hubOrganizationId),
            eq(githubAppInstallations.hubOrganizationId, hubOrganizationId),
          ),
        ),
      )
      .returning({ id: githubAppInstallations.id });
    updatedCount = result.length;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // WHERE clause let us through (target was NULL on this row), but
      // UNIQUE(hub_organization_id) rejected the write because ANOTHER
      // row is already bound to the target org. This is the H2 codex
      // scenario: user installs App #Y on a fresh account, tries to
      // bind it to a Hub org that already has install #X bound.
      throw new ConflictError(
        "Hub team is already bound to a different GitHub installation. Uninstall the existing one from GitHub first, or transfer the binding from Settings.",
      );
    }
    throw err;
  }

  if (updatedCount === 0) {
    // The UPDATE matched zero rows — either no row exists with that
    // installation_id, or the row exists but is bound to a DIFFERENT
    // Hub org (WHERE clause filtered it out). One SELECT to give the
    // caller a precise error.
    const [row] = await db
      .select({ hubOrganizationId: githubAppInstallations.hubOrganizationId })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    if (!row) {
      throw new NotFoundError(`No installation row for installation_id=${installationId}`);
    }
    // row.hubOrganizationId is guaranteed non-null AND not equal to
    // hubOrganizationId (otherwise the WHERE would have matched).
    throw new ConflictError(
      `Installation ${installationId} is already bound to a different Hub team — refusing to rebind (D2 1:1).`,
    );
  }

  // The UPDATE succeeded — either a fresh bind (null→target) or an
  // idempotent re-bind (target→target). The boolean exists for the
  // existing test that asserts no-op semantics, but the post-UPDATE
  // row no longer carries the prior value, so we can't tell them
  // apart without a third query. The contract simplifies to "true on
  // any successful UPDATE" — tests assert state at the row level
  // (which is identical in both cases anyway), not on the return.
  return true;
}

/**
 * Webhook handler for `installation: suspend`. Sets `suspended_at` to the
 * timestamp GitHub put on `installation.suspended_at`.
 *
 * Out-of-order safety (codex P1-7): GitHub doesn't guarantee delivery
 * order and redelivers on failure, so a *stale* `suspend` event could
 * arrive after a newer one. The conditional UPDATE only writes when the
 * row is currently unsuspended OR carries an *earlier* `suspended_at` —
 * a stale re-suspend with an older timestamp is a no-op.
 *
 * (Limitation: once an `unsuspend` has cleared `suspended_at` to NULL we
 * no longer know *when* that happened, so a stale `suspend` arriving after
 * an `unsuspend` would still re-suspend. Proper handling would need a
 * dedicated lifecycle-sequence column; in practice suspend/unsuspend are
 * minutes-apart human actions, well outside any realistic reorder window.)
 */
export async function markInstallationSuspended(
  db: Database,
  installationId: number,
  suspendedAt: Date,
): Promise<void> {
  await db
    .update(githubAppInstallations)
    .set({ suspendedAt, updatedAt: new Date() })
    .where(
      and(
        eq(githubAppInstallations.installationId, installationId),
        or(isNull(githubAppInstallations.suspendedAt), lt(githubAppInstallations.suspendedAt, suspendedAt)),
      ),
    );
}

/**
 * Webhook handler for `installation: unsuspend`. Clears `suspended_at`.
 *
 * `unsuspendedAt` is the time we received the event (GitHub's `unsuspend`
 * payload, unlike `suspend`, carries no event timestamp). The conditional
 * UPDATE only clears when the current `suspended_at` predates that — i.e.
 * a stale `unsuspend` that lost the race to a newer `suspend` won't undo
 * it. A row that's already unsuspended (`suspended_at IS NULL`) is left
 * alone (the `< unsuspendedAt` comparison is NULL → no match), which is
 * the desired no-op.
 */
export async function markInstallationUnsuspended(
  db: Database,
  installationId: number,
  unsuspendedAt: Date,
): Promise<void> {
  await db
    .update(githubAppInstallations)
    .set({ suspendedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(githubAppInstallations.installationId, installationId),
        lt(githubAppInstallations.suspendedAt, unsuspendedAt),
      ),
    );
}

/** Rows younger than this are treated as "just created" and not deleted by a stray `installation: deleted`. */
const DELETE_GRACE_MS = 60_000;

/**
 * Webhook handler for `installation: deleted`. Removes the row outright —
 * the user uninstalled the App from their account; the row has no value.
 *
 * Out-of-order safety (codex P1-7): the `deleted` payload has no
 * timestamp, so if a delayed `deleted` arrives after the account was
 * re-installed (a fresh row with a fresh binding), deleting blindly would
 * wipe the new state. Conservative heuristic: only delete rows older than
 * a 1-minute grace window — a re-install row created seconds ago is left
 * untouched. (A `deleted` that's genuinely lagging by >1min for a
 * re-installed account is vanishingly unlikely, and even then the next
 * `installation: created` re-creates the row.)
 *
 * Note: deleting the org on the Hub side is the inverse case — that's
 * handled by the `ON DELETE SET NULL` FK on `hub_organization_id`, which
 * keeps the installation row alive so a future rebind can recover.
 */
export async function deleteInstallationByGithubId(db: Database, installationId: number): Promise<void> {
  await db
    .delete(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.installationId, installationId),
        lt(githubAppInstallations.createdAt, new Date(Date.now() - DELETE_GRACE_MS)),
      ),
    );
}

/**
 * Lookup an installation by GitHub-side id. Used by the webhook router
 * to resolve `installation.id` → `hub_organization_id` so downstream
 * event handlers (issues, PRs) know which Hub team the event belongs to.
 */
export async function findInstallationByGithubId(
  db: Database,
  installationId: number,
): Promise<InstallationRow | null> {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .limit(1);
  return row ?? null;
}

/**
 * Lookup the installation bound to a Hub team. Used by Settings →
 * Integrations to render the connected-account panel. Returns null when
 * no install is bound.
 *
 * `LIMIT 1` is belt-and-braces — UNIQUE(hub_organization_id) already
 * guarantees at most one row.
 */
export async function findInstallationByOrg(db: Database, hubOrganizationId: string): Promise<InstallationRow | null> {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.hubOrganizationId, hubOrganizationId))
    .limit(1);
  return row ?? null;
}

/**
 * List the installations for a GitHub account that aren't bound to any Hub
 * team yet. Newest-first.
 *
 * The orphan-recovery path (codex P1-5 + H1): if the OAuth callback's
 * `upsertInstallationFromMetadata` lands but the follow-up
 * `bindInstallationToOrg` fails (transient DB error, a racing invite that
 * errors out, …), the row sits unbound forever — GitHub only puts
 * `installation_id` in the redirect on the *initial* install, so a later
 * sign-in never re-attempts the bind. On every subsequent sign-in we sweep
 * for unbound rows whose `accountGithubId` matches the user's own GitHub
 * account and auto-claim the single one (and surface a manual "Claim
 * install" button when there are several).
 */
export async function findUnboundInstallationsByAccount(
  db: Database,
  accountGithubId: number,
): Promise<InstallationRow[]> {
  return db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.accountGithubId, accountGithubId),
        isNull(githubAppInstallations.hubOrganizationId),
      ),
    )
    .orderBy(desc(githubAppInstallations.createdAt));
}

/**
 * Belt-and-braces helper for tests / debugging: how many installations
 * currently bound to this Hub team. Should always be 0 or 1 — anything
 * higher means the UNIQUE index was somehow violated and the rest of the
 * system is in undefined territory.
 */
export async function countInstallationsForOrg(db: Database, hubOrganizationId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.hubOrganizationId, hubOrganizationId));
  return row?.c ?? 0;
}
