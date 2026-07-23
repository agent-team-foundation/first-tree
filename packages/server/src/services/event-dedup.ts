import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

// ── Event deduplication ─────────────────────────────────────────────
//
// Claim lifecycle (see db/schema/processed-events.ts):
//
//   claimEvent    → INSERT status='pending' with an expiry, or atomically
//                   take over an expired 'pending' row. Fails against 'done'
//                   rows and unexpired in-flight 'pending' rows.
//   completeEvent → flip 'pending' → 'done' after the handler succeeded.
//   unclaimEvent  → best-effort delete of the 'pending' row on handler
//                   failure so the provider's immediate retry can clear.
//                   Correctness does NOT depend on it: if it never runs,
//                   the 'pending' claim expires and a redelivery takes it
//                   over via claimEvent.
//   sweepExpiredEventClaims → background cleanup of expired 'pending'
//                   rows so the table does not accumulate stuck claims.

/** How long a `pending` claim blocks other deliveries of the same event. */
export const EVENT_CLAIM_TTL_SECONDS = 300;

/**
 * Attempt to claim an event for processing.
 *
 * Returns true when this delivery should be processed: either the event was
 * never seen, or a previous claim is still `pending` past its expiry (the
 * previous processor crashed or stalled) and this delivery takes it over.
 * Returns false for duplicates: the event is `done`, or another processor
 * holds an unexpired `pending` claim right now.
 *
 * Atomicity: `INSERT ... ON CONFLICT DO UPDATE` locks the conflicting row,
 * so two concurrent deliveries of the same id serialize and exactly one
 * gets the claim.
 */
export async function claimEvent(
  db: Database,
  eventId: string,
  platform: string,
  ttlSeconds: number = EVENT_CLAIM_TTL_SECONDS,
): Promise<boolean> {
  const result = await db.execute<{ event_id: string }>(
    sql`INSERT INTO processed_events (event_id, platform, status, expires_at)
        VALUES (${eventId}, ${platform}, 'pending', now() + make_interval(secs => ${ttlSeconds}))
        ON CONFLICT (event_id, platform) DO UPDATE
          SET status = 'pending',
              expires_at = now() + make_interval(secs => ${ttlSeconds}),
              created_at = now()
          WHERE processed_events.status = 'pending' AND processed_events.expires_at <= now()
        RETURNING event_id`,
  );
  return result.length > 0;
}

/**
 * Mark a claimed event as successfully processed so future redeliveries of
 * the same id are deduped permanently. Returns false when no `pending` claim
 * existed (e.g. it expired and was swept or taken over mid-processing).
 */
export async function completeEvent(db: Database, eventId: string, platform: string): Promise<boolean> {
  const result = await db.execute<{ event_id: string }>(
    sql`UPDATE processed_events
        SET status = 'done', expires_at = NULL
        WHERE event_id = ${eventId} AND platform = ${platform} AND status = 'pending'
        RETURNING event_id`,
  );
  return result.length > 0;
}

/**
 * Remove a `pending` claim so the event can be retried on the provider's
 * next delivery without waiting for the claim to expire. Called when
 * processing fails after claimEvent() succeeded. Best-effort optimization
 * only — an untouched `pending` claim expires on its own.
 */
export async function unclaimEvent(db: Database, eventId: string, platform: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM processed_events
        WHERE event_id = ${eventId} AND platform = ${platform} AND status = 'pending'`,
  );
}

/**
 * Delete expired `pending` claims left behind by crashed processors so the
 * table does not accumulate stuck rows. Redelivery correctness does not
 * depend on the sweep (claimEvent takes expired claims over in place), but
 * the sweep keeps the table bounded. Returns the number of rows removed.
 */
export async function sweepExpiredEventClaims(db: Database): Promise<number> {
  const result = await db.execute<{ event_id: string }>(
    sql`DELETE FROM processed_events
        WHERE status = 'pending' AND expires_at <= now()
        RETURNING event_id`,
  );
  return result.length;
}
