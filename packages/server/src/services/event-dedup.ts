import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

// ── Event deduplication ─────────────────────────────────────────────

/**
 * How long a `pending` claim may block redelivery before an expired-claim
 * takeover or the background sweep makes the event processable again. Bounds
 * the blast radius of a process crash between claim and completion (#317).
 */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Attempt to claim an event for processing.
 * Returns true if this caller acquired the claim, false if the event is a
 * duplicate (already `done`, or `pending` and still within its TTL).
 *
 * Acquisition and expired-claim takeover are one atomic statement: a fresh
 * id INSERTs a `pending` claim; on conflict the conditional UPDATE only
 * lands when the existing claim is `pending` AND expired, so a crashed
 * handler's leaked claim never blocks reprocessing beyond the TTL, while a
 * concurrent live delivery always loses the race exactly once.
 *
 * Note: claims carry no fencing token. A handler that outlives the TTL can
 * race a legitimate takeover and both attempts process concurrently — an
 * accepted trade-off of the claim-with-TTL design.
 */
export async function claimEvent(db: Database, eventId: string, platform: string): Promise<boolean> {
  // DB-clock expiry (now() + TTL), not app-clock: the same clock later
  // evaluates `expires_at < now()` for takeover and sweep, so the two can
  // never skew. CLAIM_TTL_MS stays the single source for the TTL value.
  const claimTtlSeconds = CLAIM_TTL_MS / 1000;
  const result = await db.execute<{ event_id: string }>(
    sql`INSERT INTO processed_events (event_id, platform, status, expires_at)
        VALUES (${eventId}, ${platform}, 'pending', now() + ${claimTtlSeconds} * interval '1 second')
        ON CONFLICT (event_id, platform) DO UPDATE
          SET status = 'pending', expires_at = now() + ${claimTtlSeconds} * interval '1 second'
          WHERE processed_events.status = 'pending'
            AND processed_events.expires_at < now()
        RETURNING event_id`,
  );
  return result.length > 0;
}

/**
 * Mark a claimed event as successfully processed. Redeliveries dedupe only
 * against `done` claims, so this is the commit point of the claim lifecycle.
 * Clears `expires_at` — a `done` claim never expires.
 */
export async function markEventDone(db: Database, eventId: string, platform: string): Promise<void> {
  await db.execute(
    sql`UPDATE processed_events
        SET status = 'done', expires_at = NULL
        WHERE event_id = ${eventId} AND platform = ${platform} AND status = 'pending'`,
  );
}

/**
 * Remove a claimed event so it can be retried on next delivery.
 * Called when processing fails after claimEvent() succeeded. Purely an
 * optimization for fast redelivery — correctness never depends on it: had
 * the delete never run, the `pending` claim would expire on its own.
 */
export async function unclaimEvent(db: Database, eventId: string, platform: string): Promise<void> {
  await db.execute(sql`DELETE FROM processed_events WHERE event_id = ${eventId} AND platform = ${platform}`);
}

/**
 * Delete expired `pending` claims so redelivery is never starved by a leaked
 * claim and the table does not accumulate stuck rows. Returns the number of
 * rows removed. Expired claims are also taken over atomically by the next
 * claimEvent() call — this sweep is the hygiene backstop.
 */
export async function sweepExpiredClaims(db: Database): Promise<number> {
  const result = await db.execute<{ event_id: string }>(
    sql`DELETE FROM processed_events WHERE status = 'pending' AND expires_at < now() RETURNING event_id`,
  );
  return result.length;
}
