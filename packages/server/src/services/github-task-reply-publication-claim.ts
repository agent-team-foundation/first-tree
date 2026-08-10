import { GITHUB_TASK_REPLY_RUN_MARKER_PREFIX } from "@first-tree/shared";
import type { Database } from "../db/connection.js";
import { claimEvent, unclaimEvent } from "./event-dedup.js";
import { type GithubIssueComment, listIssueCommentsForRun } from "./github-app.js";

/**
 * Cross-run publication guard for App-authored GitHub task replies.
 *
 * The submission state on a run's own message row makes ONE run idempotent. It
 * says nothing about a sibling run, so duplicate or concurrent dispatch for the
 * same entity published one identical comment per run — five byte-identical
 * Context Reviewer verdicts on one unchanged pull request head is the case this
 * module exists to make impossible.
 *
 * Two guards, in order:
 *
 *  1. An atomic claim keyed on the publisher's existing `payloadHash`
 *     (`sha256([repository, entityType, entityNumber, body])`). That hash is
 *     already run-independent by construction: it identifies the exact comment
 *     about to be written, not the run writing it. A verdict rendered against a
 *     moved head names a different head and therefore hashes differently, so a
 *     real re-review still publishes; a byte-identical repeat cannot.
 *
 *  2. For the run that loses the claim, a read-back of the hidden
 *     `first-tree-github-task-reply-run` marker on the entity's existing App
 *     comments. Until now that marker was written and never read as a publish
 *     guard, so a losing run had no way to learn its reply was already on
 *     GitHub. The read-back turns the loss into a definite answer — "your exact
 *     reply is already published at <url>" — instead of a blind retry.
 */

const PUBLICATION_CLAIM_PLATFORM = "github-task-reply-publication";

/**
 * `processed_events` already provides exactly-once claim semantics through its
 * `(event_id, platform)` unique index; the dedicated `platform` value keeps
 * publication claims from ever colliding with webhook delivery ids.
 */
export function githubTaskReplyPublicationClaimKey(organizationId: string, payloadHash: string): string {
  return `${organizationId}:${payloadHash}`;
}

/**
 * Take the publication claim for this exact reply.
 *
 * Call inside the transaction that also claims the run, and before that run
 * claim: a lost publication claim must leave the run untouched so it stays
 * retryable. `INSERT ... ON CONFLICT DO NOTHING` makes the race decision one
 * atomic statement rather than a read-then-write, which is what makes two runs
 * dispatched at the same instant resolve to exactly one publisher.
 */
export async function claimGithubTaskReplyPublication(
  db: Database,
  input: { organizationId: string; payloadHash: string },
): Promise<boolean> {
  return claimEvent(
    db,
    githubTaskReplyPublicationClaimKey(input.organizationId, input.payloadHash),
    PUBLICATION_CLAIM_PLATFORM,
  );
}

/**
 * Release a claim whose GitHub write was definitively rejected, so the reply
 * becomes publishable again.
 *
 * Never call this for an *unknown* write outcome: the comment may exist, and
 * re-opening the claim would authorize the duplicate this module prevents. The
 * owning run's existing reconciliation path resolves those.
 *
 * A claim can therefore outlive its owner — an unresolved unknown write, or a
 * crash in the narrow window between the claim transaction committing and
 * GitHub answering. That strands one exact body on one entity, not the
 * reviewer: the next run re-reads live state and publishes whatever it finds
 * then, which is a different body and a different claim.
 */
export async function releaseGithubTaskReplyPublication(
  db: Database,
  input: { organizationId: string; payloadHash: string },
): Promise<void> {
  await unclaimEvent(
    db,
    githubTaskReplyPublicationClaimKey(input.organizationId, input.payloadHash),
    PUBLICATION_CLAIM_PLATFORM,
  );
}

/**
 * Find an App comment on this entity whose caller-authored body is exactly the
 * reply we were about to publish, whichever run published it.
 *
 * Returns `null` when nothing matches and when GitHub cannot be read — a losing
 * run must not publish either way, and an unreadable entity is reported as "the
 * owner is still in flight" rather than as "nothing is published".
 */
export async function findPublishedGithubTaskReply(input: {
  token: string;
  appSlug: string;
  owner: string;
  repo: string;
  entityNumber: number;
  body: string;
  fetcher?: typeof fetch;
}): Promise<GithubIssueComment | null> {
  const comments = await listIssueCommentsForRun(
    input.token,
    {
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.entityNumber,
      // Every run marker starts with this prefix, so the shared lister returns
      // the App's task replies for *all* runs on the entity — which is exactly
      // the cross-run view a publish guard needs.
      marker: GITHUB_TASK_REPLY_RUN_MARKER_PREFIX,
      appSlug: input.appSlug,
    },
    { fetcher: input.fetcher },
  ).catch(() => null);
  if (!comments) return null;
  const expected = input.body.trimEnd();
  return comments.find((comment) => stripRunMarker(comment.body) === expected) ?? null;
}

/**
 * Recover the caller-authored body from a published reply. Mirrors the
 * publisher's `replyBody` composition exactly — body, blank line, hidden run
 * marker — and refuses anything that does not match that shape so an
 * unrelated App comment can never be read as a duplicate.
 */
function stripRunMarker(commentBody: string): string | null {
  const separator = `\n\n${GITHUB_TASK_REPLY_RUN_MARKER_PREFIX}`;
  const markerStart = commentBody.lastIndexOf(separator);
  if (markerStart < 0) return null;
  const marker = commentBody.slice(markerStart + 2);
  if (!/^<!-- first-tree-github-task-reply-run:[0-9A-Za-z-]+ -->$/.test(marker)) return null;
  return commentBody.slice(0, markerStart);
}
