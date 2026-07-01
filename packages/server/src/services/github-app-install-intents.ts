import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { githubAppInstallIntents } from "../db/schema/github-app-install-intents.js";
import { uuidv7 } from "../uuid.js";

/**
 * Pending install-intent layer — the trusted correlation between an
 * admin-initiated "install the App for org T" kickoff and the later
 * `installation.created` webhook (see the table jsdoc in
 * `db/schema/github-app-install-intents.ts` and
 * `system/cloud/github/github-app.md`).
 *
 * Binding is NOT driven by the browser-supplied URL `installation_id`
 * (unsigned, forgeable). Instead:
 *   1. `/install-url` records an intent keyed by the kickoff admin's
 *      GitHub id.
 *   2. The HMAC-signed `installation.created` webhook consumes the intent
 *      by its `sender` (the GitHub-authenticated installer) and binds.
 */

/**
 * How long a kickoff intent stays consumable. Comfortably covers a slow
 * install (lingering on GitHub's repository picker) plus webhook delivery
 * lag, while bounding the window in which a stale, abandoned intent could
 * bind an unrelated later install by the same user.
 */
export const INSTALL_INTENT_TTL_MS = 30 * 60 * 1000;

export type RecordInstallIntentInput = {
  installerGithubId: number;
  targetOrganizationId: string;
  /** Defaults to now + INSTALL_INTENT_TTL_MS. */
  expiresAt?: Date;
  now?: Date;
};

/**
 * Record (or refresh) the pending install intent for a kickoff admin.
 * One active intent per installer — a fresh kickoff for a different org
 * overwrites the previous one (last-write-wins) via the UNIQUE index.
 */
export async function recordInstallIntent(db: Database, input: RecordInstallIntentInput): Promise<void> {
  const now = input.now ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + INSTALL_INTENT_TTL_MS);
  await db
    .insert(githubAppInstallIntents)
    .values({
      id: uuidv7(),
      installerGithubId: input.installerGithubId,
      targetOrganizationId: input.targetOrganizationId,
      expiresAt,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: githubAppInstallIntents.installerGithubId,
      set: {
        targetOrganizationId: input.targetOrganizationId,
        expiresAt,
        createdAt: now,
      },
    });
}

/**
 * Read (without consuming) a fresh intent for `installerGithubId`, or null
 * when no unexpired intent exists. The webhook binder peeks first, binds,
 * then deletes only on success — so a transient bind failure leaves the
 * intent in place for GitHub's webhook retry to rebind. (A permanent bind
 * conflict deletes it explicitly to stop the retry loop.)
 */
export async function peekFreshInstallIntent(
  db: Database,
  installerGithubId: number,
  now: Date = new Date(),
): Promise<{ targetOrganizationId: string } | null> {
  const [row] = await db
    .select({ targetOrganizationId: githubAppInstallIntents.targetOrganizationId })
    .from(githubAppInstallIntents)
    .where(
      and(eq(githubAppInstallIntents.installerGithubId, installerGithubId), gt(githubAppInstallIntents.expiresAt, now)),
    )
    .limit(1);
  return row ?? null;
}

/** Delete the intent for an installer (consumed after a successful or permanently-failed bind). */
export async function deleteInstallIntent(db: Database, installerGithubId: number): Promise<void> {
  await db.delete(githubAppInstallIntents).where(eq(githubAppInstallIntents.installerGithubId, installerGithubId));
}

/**
 * Housekeeping: delete intents past their TTL. Safe to call opportunistically
 * (e.g. from the webhook path); not required for correctness because
 * `consumeFreshInstallIntent` already ignores expired rows.
 */
export async function deleteExpiredInstallIntents(db: Database, now: Date = new Date()): Promise<void> {
  await db.delete(githubAppInstallIntents).where(sql`${githubAppInstallIntents.expiresAt} <= ${now}`);
}
