import { eq, lte } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { githubAppInstallIntents } from "../db/schema/github-app-install-intents.js";
import { ConflictError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { bindInstallationToOrg, findInstallationByGithubId } from "./github-app-installations.js";
import { findActiveMembership } from "./membership.js";

/**
 * Per-installation pending-bind layer — the trusted, per-install correlation
 * between an admin install kickoff and the `installation.created` webhook
 * (see the table jsdoc in `db/schema/github-app-install-intents.ts` and
 * `system/cloud/github/github-app.md`).
 *
 * Binding is NOT inferred from the browser-supplied URL `installation_id`
 * (unsigned, forgeable) nor from the installer alone. The callback records a
 * pending bind keyed by the concrete `installation_id`; the bind only lands
 * once the HMAC-signed webhook proves that installation's installer equals
 * the kickoff admin AND the kickoff admin is still an active org admin
 * (`completeInstallBind`).
 */

/**
 * How long a pending bind stays completable. Comfortably covers webhook
 * delivery lag after the callback, while bounding the window in which a
 * stale pending row lingers.
 */
export const INSTALL_INTENT_TTL_MS = 30 * 60 * 1000;

export type RecordPendingBindInput = {
  installationId: number;
  targetOrganizationId: string;
  kickoffUserId: string;
  kickoffGithubId: number;
  /** Defaults to now + INSTALL_INTENT_TTL_MS. */
  expiresAt?: Date;
  now?: Date;
};

/**
 * Record (or refresh) the pending bind for a specific installation. Keyed by
 * `installation_id` — a re-callback for the same install is an idempotent
 * refresh; concurrent installs (different `installation_id`) get independent
 * rows, so they can never cross-bind.
 */
export async function recordPendingBind(db: Database, input: RecordPendingBindInput): Promise<void> {
  const now = input.now ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + INSTALL_INTENT_TTL_MS);
  await db
    .insert(githubAppInstallIntents)
    .values({
      id: uuidv7(),
      installationId: input.installationId,
      targetOrganizationId: input.targetOrganizationId,
      kickoffUserId: input.kickoffUserId,
      kickoffGithubId: input.kickoffGithubId,
      expiresAt,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: githubAppInstallIntents.installationId,
      set: {
        targetOrganizationId: input.targetOrganizationId,
        kickoffUserId: input.kickoffUserId,
        kickoffGithubId: input.kickoffGithubId,
        expiresAt,
        createdAt: now,
      },
    });
}

/** Delete the pending bind for an installation (consumed / abandoned). */
export async function deletePendingBind(db: Database, installationId: number): Promise<void> {
  await db.delete(githubAppInstallIntents).where(eq(githubAppInstallIntents.installationId, installationId));
}

/** Housekeeping: drop pending binds past their TTL. Safe to call opportunistically. */
export async function deleteExpiredPendingBinds(db: Database, now: Date = new Date()): Promise<void> {
  await db.delete(githubAppInstallIntents).where(lte(githubAppInstallIntents.expiresAt, now));
}

export type CompleteInstallBindResult = {
  bound: boolean;
  /** Diagnostic reason — for logging + lifecycle status strings. */
  reason:
    | "bound"
    | "no-intent"
    | "intent-expired"
    | "awaiting-webhook"
    | "installer-mismatch"
    | "kickoff-not-admin"
    | "bind-conflict";
};

/**
 * Attempt to complete a pending bind for `installationId`. Called from BOTH
 * the `installation.created` webhook (after it records the installer) and the
 * OAuth callback (after it records the pending bind), so binding lands
 * whichever arrives second. Idempotent.
 *
 * Binds only when ALL hold:
 *   - a fresh pending bind exists for this installation (the callback recorded
 *     the target org from the signed kickoff);
 *   - the installation row's `installer_github_id` is known (the signed
 *     `installation.created` webhook recorded the `sender`) AND equals the
 *     pending bind's `kickoff_github_id` — i.e. the installer IS the kickoff
 *     admin (this is the anti-forgery gate: a forged callback `installation_id`
 *     naming someone else's install fails here, because that install's
 *     `sender` is not the kickoff admin);
 *   - the kickoff user is STILL an active admin of the target org (live
 *     re-check — defends against mid-TTL admin revocation).
 *
 * Throws only on a transient `bindInstallationToOrg` error (so the webhook
 * caller can 500 and let GitHub redeliver); a permanent `ConflictError`
 * consumes the pending bind and returns `bind-conflict`.
 */
export async function completeInstallBind(db: Database, installationId: number): Promise<CompleteInstallBindResult> {
  const [pending] = await db
    .select()
    .from(githubAppInstallIntents)
    .where(eq(githubAppInstallIntents.installationId, installationId))
    .limit(1);
  if (!pending) return { bound: false, reason: "no-intent" };
  if (pending.expiresAt.getTime() <= Date.now()) {
    await deletePendingBind(db, installationId);
    return { bound: false, reason: "intent-expired" };
  }

  const installation = await findInstallationByGithubId(db, installationId);
  if (!installation || installation.installerGithubId === null) {
    // The signed webhook hasn't recorded the installer yet — wait for it.
    return { bound: false, reason: "awaiting-webhook" };
  }
  if (installation.installerGithubId !== pending.kickoffGithubId) {
    // The GitHub-authenticated installer is NOT the kickoff admin — this
    // installation was not created by the person who kicked off the bind.
    // Drop the pending row (forged/mismatched handle); never bind.
    await deletePendingBind(db, installationId);
    return { bound: false, reason: "installer-mismatch" };
  }

  const membership = await findActiveMembership(db, pending.kickoffUserId, pending.targetOrganizationId);
  if (!membership || membership.role !== "admin") {
    // Admin was revoked/downgraded during the TTL — refuse and consume.
    await deletePendingBind(db, installationId);
    return { bound: false, reason: "kickoff-not-admin" };
  }

  try {
    await bindInstallationToOrg(db, installationId, pending.targetOrganizationId);
  } catch (err) {
    if (err instanceof ConflictError) {
      await deletePendingBind(db, installationId);
      return { bound: false, reason: "bind-conflict" };
    }
    throw err;
  }
  await deletePendingBind(db, installationId);
  return { bound: true, reason: "bound" };
}
