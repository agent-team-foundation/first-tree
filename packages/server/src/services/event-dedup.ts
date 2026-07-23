import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { uuidv7 } from "../uuid.js";

// ── Event deduplication (claim lease) ───────────────────────────────
//
// State machine per (event_id, platform):
//
//   (no row) --claim--> pending(expires_at, claim_token) --complete--> done
//
// * claim on an existing `done` row, or on a `pending` row that has not
//   expired yet, is a duplicate (returns null).
// * claim on an EXPIRED `pending` row takes the claim over in the same
//   single statement (the previous attempt crashed or wedged), so a
//   redelivery after the TTL reprocesses the event instead of losing it.
// * release flips the current attempt's pending row to already-expired so
//   the next redelivery can take over immediately; the claim token keeps a
//   slow handler's late release/complete from touching a newer attempt.
//
// Every transition is one atomic statement on the unique key, so any number
// of replicas can race a delivery and exactly one wins.

export type WebhookClaimState = "pending" | "done";

/** Grace period the hygiene sweep leaves expired pending claims in place.
 * Correctness never depends on the sweep — expired pending rows are taken
 * over inline by the next redelivery — so the only job here is to stop
 * never-redelivered rows from accumulating forever. 24h keeps the row (and
 * its `pending` diagnosis) visible for a full ops day before deletion. */
const WEBHOOK_CLAIM_SWEEP_GRACE_SECONDS = 24 * 60 * 60;

/**
 * Attempt to claim an event delivery for processing.
 * Returns the claim token when this attempt owns the event (fresh claim or
 * takeover of an expired pending claim), or null on duplicate (`done`, or
 * `pending` still inside its TTL).
 */
export async function claimEvent(
  db: Database,
  eventId: string,
  platform: string,
  ttlSeconds: number,
): Promise<string | null> {
  const token = uuidv7();
  const result = await db.execute<{ event_id: string }>(
    sql`INSERT INTO processed_events (event_id, platform, status, expires_at, claim_token)
        VALUES (${eventId}, ${platform}, 'pending', now() + make_interval(secs => ${ttlSeconds}), ${token})
        ON CONFLICT (event_id, platform) DO UPDATE
          SET status = 'pending', expires_at = now() + make_interval(secs => ${ttlSeconds}), claim_token = ${token}
          WHERE processed_events.status = 'pending' AND processed_events.expires_at < now()
        RETURNING event_id`,
  );
  return result.length > 0 ? token : null;
}

/**
 * Mark a claimed delivery as processed. Returns false when this attempt no
 * longer holds the claim (it expired and a redelivery took it over), in
 * which case the row is left alone.
 */
export async function completeEvent(
  db: Database,
  eventId: string,
  platform: string,
  claimToken: string,
): Promise<boolean> {
  const result = await db.execute<{ event_id: string }>(
    sql`UPDATE processed_events
        SET status = 'done', expires_at = NULL, claim_token = NULL
        WHERE event_id = ${eventId} AND platform = ${platform}
          AND status = 'pending' AND claim_token = ${claimToken}
        RETURNING event_id`,
  );
  return result.length > 0;
}

/**
 * Release this attempt's claim after a processing failure so the next
 * redelivery can take over immediately. Expiring the row (instead of
 * deleting it) keeps the token guard: a takeover happening concurrently is
 * untouched, and if this release itself fails the TTL still recovers.
 */
export async function releaseClaimedEvent(
  db: Database,
  eventId: string,
  platform: string,
  claimToken: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE processed_events
        SET expires_at = now()
        WHERE event_id = ${eventId} AND platform = ${platform}
          AND status = 'pending' AND claim_token = ${claimToken}`,
  );
}

/**
 * Read the current claim state of a delivery, for duplicate diagnostics
 * (a `pending` duplicate means "an attempt owns this until expires_at" —
 * redeliver after that; `done` means processed for good). Returns null when
 * no row exists (e.g. the row was hygiene-swept since the claim attempt).
 */
export async function readClaimState(
  db: Database,
  eventId: string,
  platform: string,
): Promise<{ state: WebhookClaimState; expiresAt: Date | null } | null> {
  const result = await db.execute<{ status: WebhookClaimState; expires_at: string | Date | null }>(
    sql`SELECT status, expires_at FROM processed_events
        WHERE event_id = ${eventId} AND platform = ${platform}`,
  );
  const row = result[0];
  if (!row) return null;
  return {
    state: row.status,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
  };
}

/**
 * Hygiene sweep: delete pending claims that expired more than the grace
 * period ago and were never redelivered. Idempotent and safe under multiple
 * replicas. Returns the number of rows deleted.
 */
export async function sweepExpiredWebhookClaims(db: Database): Promise<number> {
  const result = await db.execute<{ event_id: string }>(
    sql`DELETE FROM processed_events
        WHERE status = 'pending'
          AND expires_at < now() - make_interval(secs => ${WEBHOOK_CLAIM_SWEEP_GRACE_SECONDS})
        RETURNING event_id`,
  );
  return result.length;
}
