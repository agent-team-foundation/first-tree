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
 * routes to org-owner approval (no `installation_id` exists yet). Keyed by
 * `(initiator GitHub id, target org)` — both from our own signed state —
 * consumed when the initiator returns after approval to complete the bind. The
 * per-target-org key is what lets the completion path detect an ambiguous
 * approval (an initiator with >1 fresh request) and refuse to auto-bind rather
 * than mis-route webhooks to the wrong org (see the table jsdoc).
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
 * Record (or refresh) the pending install request for an (initiator, target
 * org) pair. Re-kicking the same pair UPSERTs (last-wins); kicking off a
 * different target org adds a distinct row (see the table jsdoc — this is what
 * lets the completion path detect the ambiguous multi-request case).
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
      target: [githubAppInstallRequests.initiatorGithubId, githubAppInstallRequests.targetOrganizationId],
      set: {
        kickoffUserId: input.kickoffUserId,
        expiresAt,
        createdAt: now,
      },
    });
}

/**
 * List all fresh (unexpired) install requests for `initiatorGithubId`. The
 * completion path binds only when exactly one exists — 0 means no pending
 * request, >1 means the approval is ambiguous (see `completeInstallRequestBind`).
 */
export async function listFreshInstallRequests(
  db: Database,
  initiatorGithubId: number,
  now: Date = new Date(),
): Promise<Array<{ targetOrganizationId: string; kickoffUserId: string }>> {
  return db
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
    );
}

/** Delete one install request (an (initiator, target org) row) after a successful bind. */
export async function deleteInstallRequest(
  db: Database,
  initiatorGithubId: number,
  targetOrganizationId: string,
): Promise<void> {
  await db
    .delete(githubAppInstallRequests)
    .where(
      and(
        eq(githubAppInstallRequests.initiatorGithubId, initiatorGithubId),
        eq(githubAppInstallRequests.targetOrganizationId, targetOrganizationId),
      ),
    );
}

/** Housekeeping: drop requests past their TTL. Safe to call opportunistically. */
export async function deleteExpiredInstallRequests(db: Database, now: Date = new Date()): Promise<void> {
  await db.delete(githubAppInstallRequests).where(lte(githubAppInstallRequests.expiresAt, now));
}

export type CompleteInstallRequestResult = {
  bound: boolean;
  reason: "bound" | "no-request" | "ambiguous" | "kickoff-not-admin" | "bind-conflict";
};

/**
 * Complete the **approval-flow** bind from the `installation.created` webhook.
 * Called with the webhook's trusted `requester` (the original initiator, as
 * GitHub records it — the org owner who approved is the `sender`, not the
 * `requester`). Binds when ALL hold:
 *   - EXACTLY ONE fresh install-request exists for this initiator (captured
 *     from our signed state at request time); and
 *   - the initiator (via the request's `kickoff_user_id`) is STILL an active
 *     admin of the target org (live re-check — mirrors the self-install
 *     bind-time admin recheck).
 *
 * Ambiguity guard: GitHub's approval webhook carries no handle for WHICH of an
 * initiator's outstanding requests it fulfils (the `requester` is just the
 * initiator's id; the installed account is not correlated to a request at
 * capture time). So if the initiator has more than one fresh request (concurrent
 * installs to different orgs), auto-binding could route the installation to the
 * wrong org — we refuse and leave the orphan to `/claim`. This is why requests
 * are keyed per target org (so >1 is detectable, not silently overwritten).
 *
 * Anti-forgery: the `requester` is GitHub-authenticated, and the request row
 * could only be minted by an authenticated First Tree admin of the target org
 * (via the admin-gated `/install-url` signed state). A caller cannot forge
 * another user's request nor a non-approved installation. Consumes the matched
 * request on success or on a permanent conflict; leaves rows untouched when the
 * approval is ambiguous.
 */
export async function completeInstallRequestBind(
  db: Database,
  installationId: number,
  requesterGithubId: number,
): Promise<CompleteInstallRequestResult> {
  const requests = await listFreshInstallRequests(db, requesterGithubId);
  if (requests.length === 0) return { bound: false, reason: "no-request" };
  // Cannot tell which outstanding request this approval fulfils → refuse rather
  // than mis-bind. Leave the rows for `/claim` or expiry.
  if (requests.length > 1) return { bound: false, reason: "ambiguous" };
  const request = requests[0];
  if (!request) return { bound: false, reason: "no-request" };

  const membership = await findActiveMembership(db, request.kickoffUserId, request.targetOrganizationId);
  if (!membership || membership.role !== "admin") {
    await deleteInstallRequest(db, requesterGithubId, request.targetOrganizationId);
    return { bound: false, reason: "kickoff-not-admin" };
  }

  try {
    await bindInstallationToOrg(db, installationId, request.targetOrganizationId);
  } catch (err) {
    if (err instanceof ConflictError) {
      await deleteInstallRequest(db, requesterGithubId, request.targetOrganizationId);
      return { bound: false, reason: "bind-conflict" };
    }
    throw err;
  }
  await deleteInstallRequest(db, requesterGithubId, request.targetOrganizationId);
  return { bound: true, reason: "bound" };
}
