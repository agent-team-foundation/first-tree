import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { uuidv7 } from "../uuid.js";
import type { AppInstallation } from "./github-app.js";

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
 * org is a no-op. Different-org binding is rejected — the
 * UNIQUE(hub_organization_id) constraint guarantees 1:1 globally, and
 * we additionally refuse here so the caller gets a clean error rather
 * than a 23505 surfacing through the route layer.
 *
 * Returns `true` when this call actually updated a row; `false` when the
 * installation was already bound to the same org.
 */
export async function bindInstallationToOrg(
  db: Database,
  installationId: number,
  hubOrganizationId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ hubOrganizationId: githubAppInstallations.hubOrganizationId })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .limit(1);
  if (!existing) {
    throw new Error(`bindInstallationToOrg: no installation row for installation_id=${installationId}`);
  }
  if (existing.hubOrganizationId === hubOrganizationId) {
    return false;
  }
  if (existing.hubOrganizationId && existing.hubOrganizationId !== hubOrganizationId) {
    throw new Error(
      `bindInstallationToOrg: installation_id=${installationId} already bound to a different Hub team — refusing to rebind (D2 1:1).`,
    );
  }
  await db
    .update(githubAppInstallations)
    .set({ hubOrganizationId, updatedAt: new Date() })
    .where(eq(githubAppInstallations.installationId, installationId));
  return true;
}

/**
 * Webhook handler for `installation: suspend`. Sets `suspended_at` to
 * the supplied timestamp (or `now()` if the webhook payload omits it).
 * No-op when the row is already suspended (idempotent retry-safe).
 */
export async function markInstallationSuspended(
  db: Database,
  installationId: number,
  suspendedAt?: Date,
): Promise<void> {
  await db
    .update(githubAppInstallations)
    .set({ suspendedAt: suspendedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(githubAppInstallations.installationId, installationId));
}

/** Webhook handler for `installation: unsuspend`. Clears `suspended_at`. */
export async function markInstallationUnsuspended(db: Database, installationId: number): Promise<void> {
  await db
    .update(githubAppInstallations)
    .set({ suspendedAt: null, updatedAt: new Date() })
    .where(eq(githubAppInstallations.installationId, installationId));
}

/**
 * Webhook handler for `installation: deleted`. Removes the row outright.
 * The user uninstalled the App from their account; the row has no value.
 *
 * Note: deleting the org on the Hub side is the inverse case — that's
 * handled by the `ON DELETE SET NULL` FK on `hub_organization_id`, which
 * keeps the installation row alive so a future rebind can recover.
 */
export async function deleteInstallationByGithubId(db: Database, installationId: number): Promise<void> {
  await db.delete(githubAppInstallations).where(eq(githubAppInstallations.installationId, installationId));
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
