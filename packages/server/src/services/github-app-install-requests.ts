import { and, eq, gt, lte } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { githubAppInstallRequests } from "../db/schema/github-app-install-requests.js";
import { ConflictError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { bindInstallationToOrg } from "./github-app-installations.js";
import { findActiveMembership } from "./membership.js";

/**
 * Pending install-**request** layer — the approval-flow counterpart to
 * `github-app-install-intents` (see the table jsdoc and
 * `system/cloud/github/github-app.md`).
 *
 * Captured when a non-owner First Tree admin initiates an install that GitHub
 * routes to org-owner approval (no `installation_id` exists yet). Keyed by the
 * initiator's GitHub id (from our own signed state), consumed when the
 * initiator returns after approval to complete the bind.
 */

/**
 * How long a captured request stays completable. Covers the human latency of
 * an org owner approving the request, while bounding staleness.
 */
export const INSTALL_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RecordInstallRequestInput = {
  initiatorGithubId: number;
  targetOrganizationId: string;
  kickoffUserId: string;
  /** Defaults to now + INSTALL_REQUEST_TTL_MS. */
  expiresAt?: Date;
  now?: Date;
};

/**
 * Record (or refresh) the pending install request for an initiator. One active
 * request per initiator — a fresh kickoff overwrites the previous one.
 */
export async function recordInstallRequest(db: Database, input: RecordInstallRequestInput): Promise<void> {
  const now = input.now ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + INSTALL_REQUEST_TTL_MS);
  await db
    .insert(githubAppInstallRequests)
    .values({
      id: uuidv7(),
      initiatorGithubId: input.initiatorGithubId,
      targetOrganizationId: input.targetOrganizationId,
      kickoffUserId: input.kickoffUserId,
      expiresAt,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: githubAppInstallRequests.initiatorGithubId,
      set: {
        targetOrganizationId: input.targetOrganizationId,
        kickoffUserId: input.kickoffUserId,
        expiresAt,
        createdAt: now,
      },
    });
}

/**
 * Read (without consuming) a fresh install request for `initiatorGithubId`, or
 * null when none exists / it has expired. The completion path peeks, binds,
 * then deletes on success.
 */
export async function peekFreshInstallRequest(
  db: Database,
  initiatorGithubId: number,
  now: Date = new Date(),
): Promise<{ targetOrganizationId: string; kickoffUserId: string } | null> {
  const [row] = await db
    .select({
      targetOrganizationId: githubAppInstallRequests.targetOrganizationId,
      kickoffUserId: githubAppInstallRequests.kickoffUserId,
    })
    .from(githubAppInstallRequests)
    .where(
      and(
        eq(githubAppInstallRequests.initiatorGithubId, initiatorGithubId),
        gt(githubAppInstallRequests.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Delete the install request for an initiator (consumed after a successful bind). */
export async function deleteInstallRequest(db: Database, initiatorGithubId: number): Promise<void> {
  await db.delete(githubAppInstallRequests).where(eq(githubAppInstallRequests.initiatorGithubId, initiatorGithubId));
}

/** Housekeeping: drop requests past their TTL. Safe to call opportunistically. */
export async function deleteExpiredInstallRequests(db: Database, now: Date = new Date()): Promise<void> {
  await db.delete(githubAppInstallRequests).where(lte(githubAppInstallRequests.expiresAt, now));
}

export type CompleteInstallRequestResult = {
  bound: boolean;
  reason: "bound" | "no-request" | "kickoff-not-admin" | "bind-conflict";
};

/**
 * Complete the **approval-flow** bind from the `installation.created` webhook.
 * Called with the webhook's trusted `requester` (the original initiator, as
 * GitHub records it — the org owner who approved is the `sender`, not the
 * `requester`). Binds when ALL hold:
 *   - a fresh install-request exists for this initiator (captured from our
 *     signed state at request time); and
 *   - the initiator (via the request's `kickoff_user_id`) is STILL an active
 *     admin of the target org (live re-check — mirrors the self-install
 *     bind-time admin recheck).
 *
 * Anti-forgery: the `requester` is GitHub-authenticated, and the request row
 * could only be minted by an authenticated First Tree admin of the target org
 * (via the admin-gated `/install-url` signed state). A caller cannot forge
 * another user's request nor a non-approved installation. Consumes the
 * request on success or on a permanent conflict.
 */
export async function completeInstallRequestBind(
  db: Database,
  installationId: number,
  requesterGithubId: number,
): Promise<CompleteInstallRequestResult> {
  const request = await peekFreshInstallRequest(db, requesterGithubId);
  if (!request) return { bound: false, reason: "no-request" };

  const membership = await findActiveMembership(db, request.kickoffUserId, request.targetOrganizationId);
  if (!membership || membership.role !== "admin") {
    await deleteInstallRequest(db, requesterGithubId);
    return { bound: false, reason: "kickoff-not-admin" };
  }

  try {
    await bindInstallationToOrg(db, installationId, request.targetOrganizationId);
  } catch (err) {
    if (err instanceof ConflictError) {
      await deleteInstallRequest(db, requesterGithubId);
      return { bound: false, reason: "bind-conflict" };
    }
    throw err;
  }
  await deleteInstallRequest(db, requesterGithubId);
  return { bound: true, reason: "bound" };
}
