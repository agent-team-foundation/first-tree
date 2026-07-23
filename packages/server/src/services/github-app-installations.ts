import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { organizations } from "../db/schema/organizations.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
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
 * `bindInstallationToOrg` is the row-level bind primitive. Its production
 * caller is `connectInstallationToOrg` (the explicit connect-panel action);
 * the dev-callback QA stub also calls it directly. Idempotent: re-binding
 * the same installation to the same org is a no-op, and the
 * UNIQUE(hub_organization_id) constraint enforces D2 1:1 (a different
 * user connecting the same installation_id MUST NOT rebind it to their
 * org).
 */

export type UpsertInstallationInput = {
  installation: AppInstallation;
  /**
   * Optional First Tree org id to bind. Used when the install-callback path
   * already knows the user's primary org at insert time. Webhook path
   * omits this — webhooks don't know which First Tree user installed the App;
   * the binding is established by the callback path's
   * `bindInstallationToOrg` instead.
   */
  hubOrganizationId?: string;
  /**
   * GitHub numeric id of the user who installed the App — the `sender` on
   * the `installation.created` webhook. Only pass it on `created` (the
   * install moment); later lifecycle webhooks omit it and the original
   * installer is preserved via COALESCE. This is the trusted anti-forgery
   * anchor for binding (see the column jsdoc).
   */
  installerGithubId?: number;
  /**
   * GitHub numeric id of the user who requested the install through the
   * owner-approval flow — the top-level `requester` block on the
   * `installation.created` webhook. Same COALESCE-preserve semantics as
   * `installerGithubId`. Absent on direct installs.
   */
  requesterGithubId?: number;
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
    installerGithubId: input.installerGithubId ?? null,
    requesterGithubId: input.requesterGithubId ?? null,
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
        // Preserve the original installer: only fill it when currently
        // NULL (a `created` webhook that seeds a row first-seen via a
        // later lifecycle event). Never overwrite a known installer with
        // a subsequent event's `sender` (which may be a different admin
        // accepting new permissions).
        installerGithubId: sql`coalesce(${githubAppInstallations.installerGithubId}, ${values.installerGithubId})`,
        // Same preserve semantics for the approval-flow requester.
        requesterGithubId: sql`coalesce(${githubAppInstallations.requesterGithubId}, ${values.requesterGithubId})`,
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
 * Bind an installation to a First Tree team. Idempotent: re-binding to the same
 * org is a no-op at the row level.
 *
 * Race-safe (codex P0-3): the previous SELECT-then-UPDATE implementation
 * had a TOCTOU window — two concurrent callbacks for the same unbound
 * installation but different First Tree orgs could both see `hubOrganizationId
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
 *     different First Tree team (D2 1:1), or (b) the target First Tree team is
 *     already bound to a different installation.
 *
 * Returns `true` on any successful UPDATE — fresh bind and idempotent
 * re-bind both succeed identically and we don't pay the extra SELECT to
 * tell them apart. The boolean exists for forward-compat with callers
 * that may want to surface a "freshly bound" log line; today both paths
 * leave the row in the same state, so the value is advisory.
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
      // bind it to a First Tree org that already has install #X bound.
      throw new ConflictError(
        "First Tree team is already bound to a different GitHub installation. Uninstall the existing one from GitHub first, or transfer the binding from Settings.",
      );
    }
    throw err;
  }

  if (updatedCount === 0) {
    // The UPDATE matched zero rows — either no row exists with that
    // installation_id, or the row exists but is bound to a DIFFERENT
    // First Tree org (WHERE clause filtered it out). One SELECT to give the
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
      `Installation ${installationId} is already bound to a different First Tree team — refusing to rebind (D2 1:1).`,
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

/**
 * Webhook handler for `installation: deleted`. Removes the row outright —
 * the user uninstalled the App from their account; the row has no value.
 *
 * The earlier 60-s `createdAt`-based grace window (added in C.12 codex P1-7
 * to guard against delayed `deleted` events clobbering fresh re-installs)
 * was reverted after a post-Phase-C codex challenge flagged a worse bug:
 * a real install + immediate uninstall (within 60 s) became permanent —
 * the handler returned a 200 no-op so GitHub never redelivered, and the
 * First Tree-side row lived forever even though the App was gone upstream.
 *
 * The original race the grace was meant to solve doesn't actually exist:
 * GitHub mints a fresh `installation.id` per install, so a delayed
 * `deleted` for id N cannot wipe a fresh re-install (which has id M ≠ N).
 * Same-id replays are not deduped — installation lifecycle events branch
 * off before the `processed_events` claim pipeline (see
 * githubAppWebhookRoutes) — but the lifecycle handlers absorb them
 * idempotently (upsert/update semantics).
 *
 * The remaining "stale `created` after `deleted` resurrects the row" risk
 * is a pre-existing hole in `upsertInstallationFromMetadata` (not
 * introduced by Phase C). Tracked as a Phase D follow-up — the upsert
 * path needs a `last_lifecycle_event_at` column or tombstone to be
 * order-safe.
 *
 * Note: deleting the org on the First Tree side is the inverse case — handled
 * by the `ON DELETE SET NULL` FK on `hub_organization_id`, which keeps
 * the installation row alive so a future rebind can recover.
 */
export async function deleteInstallationByGithubId(db: Database, installationId: number): Promise<void> {
  await db.delete(githubAppInstallations).where(eq(githubAppInstallations.installationId, installationId));
}

/**
 * Lookup an installation by GitHub-side id. Used by the webhook router
 * to resolve `installation.id` → `hub_organization_id` so downstream
 * event handlers (issues, PRs) know which First Tree team the event belongs to.
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
 * Lookup the installation bound to a First Tree team. Used by Settings →
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
 * Belt-and-braces helper for tests / debugging: how many installations
 * currently bound to this First Tree team. Should always be 0 or 1 — anything
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

// ── Connect panel ─────────────────────────────────────────────────────
//
// Binding is an explicit user action under the unified connect model: the
// `installation.created` webhook records every installation unbound, and a
// team admin connects one from the Settings panel of the team it should
// bind to. The target team is therefore always "the team whose panel the
// caller is on" — no server-side install intent, no auto-bind. Authorization
// rests entirely on data we already hold: the caller must be an admin of the
// target team (route layer) and their GitHub id must equal the installation's
// webhook-verified requester or installer (here). No GitHub API call, no
// GitHub permission is involved.

export type AssociatedInstallation = InstallationRow & {
  /** Display name of the bound team; null while unbound. */
  connectedTeamName: string | null;
};

/**
 * The connect panel's row set for one (caller, team) pair — the union of:
 *
 *   - installations associated with the caller (their trusted requester
 *     or installer id equals `githubUserId`), and
 *   - the installation bound to `hubOrganizationId` itself, REGARDLESS of
 *     association. The binding is the team's resource: any team admin
 *     must see it (and reach its Disconnect) even when the original
 *     requester/installer left the team or the caller has no GitHub
 *     identity at all — otherwise the summary says "connected" while the
 *     management panel shows nothing.
 *
 * `githubUserId` is null when the caller has no GitHub identity on file;
 * only the team-bound row (if any) is returned then. Newest install
 * first, so a just-approved installation surfaces at the top while the
 * panel polls.
 */
export async function listConnectPanelInstallations(
  db: Database,
  input: { githubUserId: number | null; hubOrganizationId: string },
): Promise<AssociatedInstallation[]> {
  const boundHere = eq(githubAppInstallations.hubOrganizationId, input.hubOrganizationId);
  const rows = await db
    .select({ installation: githubAppInstallations, connectedTeamName: organizations.displayName })
    .from(githubAppInstallations)
    .leftJoin(organizations, eq(githubAppInstallations.hubOrganizationId, organizations.id))
    .where(
      input.githubUserId === null
        ? boundHere
        : or(
            boundHere,
            eq(githubAppInstallations.requesterGithubId, input.githubUserId),
            eq(githubAppInstallations.installerGithubId, input.githubUserId),
          ),
    )
    .orderBy(desc(githubAppInstallations.createdAt));
  return rows.map((r) => ({ ...r.installation, connectedTeamName: r.connectedTeamName ?? null }));
}

/**
 * Connect an installation to a First Tree team from the panel.
 *
 * Authorization (the route already verified team admin): the caller's
 * GitHub id must equal the installation's webhook-verified requester or
 * installer — the two GitHub-authenticated links between a person and an
 * installation. `callerGithubId` is null when the caller has no GitHub
 * identity on file; that fails the same check (they can't be associated
 * with any installation).
 *
 * Throws:
 *   - NotFoundError — no row with this installation id.
 *   - ForbiddenError — caller is neither requester nor installer.
 *   - ConflictError — 1:1 violation, via `bindInstallationToOrg` (this
 *     installation is bound to another team, or this team already holds a
 *     different installation).
 */
export async function connectInstallationToOrg(
  db: Database,
  input: { installationId: number; hubOrganizationId: string; callerGithubId: number | null },
): Promise<InstallationRow> {
  const row = await findInstallationByGithubId(db, input.installationId);
  if (!row) {
    throw new NotFoundError(`No installation row for installation_id=${input.installationId}`);
  }
  const associated =
    input.callerGithubId !== null &&
    (row.requesterGithubId === input.callerGithubId || row.installerGithubId === input.callerGithubId);
  if (!associated) {
    throw new ForbiddenError("This installation is not associated with your GitHub account");
  }
  await bindInstallationToOrg(db, input.installationId, input.hubOrganizationId);
  return row;
}

/**
 * Disconnect whatever installation is bound to this team. Clears only the
 * First Tree-side binding — the GitHub-side installation is untouched, so
 * the row survives (with its requester/installer anchors) and can be
 * reconnected from any panel later. Team admins may disconnect their own
 * team's binding regardless of who originally installed it: the binding is
 * the team's resource.
 *
 * Throws NotFoundError when the team has no bound installation.
 */
export async function disconnectInstallationFromOrg(db: Database, hubOrganizationId: string): Promise<InstallationRow> {
  const [row] = await db
    .update(githubAppInstallations)
    .set({ hubOrganizationId: null, updatedAt: new Date() })
    .where(eq(githubAppInstallations.hubOrganizationId, hubOrganizationId))
    .returning();
  if (!row) {
    throw new NotFoundError("No GitHub App installation is bound to this team");
  }
  return row;
}
