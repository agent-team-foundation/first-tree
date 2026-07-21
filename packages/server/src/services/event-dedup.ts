import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

export const EVENT_CLAIM_TTL_SECONDS = 5 * 60;
export const EVENT_CLAIM_SWEEP_BATCH_SIZE = 1_000;

const MAX_ACQUISITION_ATTEMPTS = 5;

export type EventClaimAcquisition =
  | { outcome: "acquired"; expiresAt: Date }
  | { outcome: "in_flight"; expiresAt: Date; retryAfterSeconds: number }
  | { outcome: "done" };

type AcquiredRow = {
  expires_at: Date | string;
};

type ClassifiedRow = {
  status: string;
  expires_at: Date | string | null;
  retry_after_seconds: number | string | null;
};

/**
 * Atomically acquire a new event claim or take over an expired pending claim.
 * Completed events are never reopened. A live pending claim is reported
 * separately so callers do not acknowledge unfinished work as a duplicate.
 */
export async function claimEvent(db: Database, eventId: string, platform: string): Promise<EventClaimAcquisition> {
  for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
    const acquired = await db.execute<AcquiredRow>(sql`
      WITH claim_clock AS MATERIALIZED (
        SELECT date_trunc('milliseconds', clock_timestamp()) AS acquired_at
      )
      INSERT INTO processed_events (event_id, platform, status, expires_at)
      SELECT
        ${eventId},
        ${platform},
        'pending',
        acquired_at + ${EVENT_CLAIM_TTL_SECONDS} * interval '1 second'
      FROM claim_clock
      ON CONFLICT ON CONSTRAINT uq_processed_event
      DO UPDATE SET
        status = 'pending',
        expires_at = EXCLUDED.expires_at
      WHERE processed_events.status = 'pending'
        AND processed_events.expires_at <= (SELECT acquired_at FROM claim_clock)
      RETURNING processed_events.expires_at
    `);
    const acquiredRow = acquired[0];
    if (acquiredRow) {
      return { outcome: "acquired", expiresAt: parseDatabaseDate(acquiredRow.expires_at, "acquired expiry") };
    }

    // A conditional UPSERT returns no row for both completed and live
    // pending claims. Classify from a fresh READ COMMITTED statement snapshot
    // using one database clock value. A sweep can remove an expired claim
    // between statements, in which case acquisition is retried.
    const classified = await db.execute<ClassifiedRow>(sql`
      WITH classification_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS observed_at
      )
      SELECT
        pe.status,
        pe.expires_at,
        CASE
          WHEN pe.status = 'pending' AND pe.expires_at > classification_clock.observed_at
            THEN GREATEST(
              1,
              ceil(EXTRACT(EPOCH FROM (pe.expires_at - classification_clock.observed_at)))::integer
            )
          ELSE NULL
        END AS retry_after_seconds
      FROM processed_events AS pe
      CROSS JOIN classification_clock
      WHERE pe.event_id = ${eventId}
        AND pe.platform = ${platform}
    `);
    const current = classified[0];
    if (!current) continue;

    if (current.status === "done") {
      if (current.expires_at !== null) {
        throw new Error("processed event is done but still has an expiry");
      }
      return { outcome: "done" };
    }

    if (current.status === "pending") {
      if (current.expires_at === null) {
        throw new Error("processed event is pending without an expiry");
      }
      if (current.retry_after_seconds === null) continue;

      const retryAfterSeconds = Number(current.retry_after_seconds);
      if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
        throw new Error("processed event has an invalid retry interval");
      }
      return {
        outcome: "in_flight",
        expiresAt: parseDatabaseDate(current.expires_at, "pending expiry"),
        retryAfterSeconds,
      };
    }

    throw new Error(`processed event has invalid status: ${current.status}`);
  }

  throw new Error("processed event claim state did not stabilize");
}

/** Mark exactly the acquired pending generation as completed. */
export async function completeEventClaim(
  db: Database,
  eventId: string,
  platform: string,
  expiresAt: Date,
): Promise<void> {
  const expiresAtIso = expiresAt.toISOString();
  const completed = await db.execute<{ event_id: string }>(sql`
    UPDATE processed_events
    SET status = 'done', expires_at = NULL
    WHERE event_id = ${eventId}
      AND platform = ${platform}
      AND status = 'pending'
      AND expires_at = ${expiresAtIso}::timestamptz
    RETURNING event_id
  `);
  if (completed.length === 0) {
    throw new Error(`lost ownership of ${platform} event claim ${eventId}`);
  }
}

/** Delete one bounded batch of expired pending claims. Completed rows remain. */
export async function sweepExpiredEventClaims(db: Database): Promise<number> {
  const result = await db.execute<{ deleted_count: number | string }>(sql`
    WITH sweep_clock AS MATERIALIZED (
      SELECT statement_timestamp() AS cutoff
    ),
    expired AS MATERIALIZED (
      SELECT pe.id
      FROM processed_events AS pe
      WHERE pe.status = 'pending'
        AND pe.expires_at <= (SELECT cutoff FROM sweep_clock)
      ORDER BY pe.expires_at ASC, pe.id ASC
      FOR UPDATE OF pe SKIP LOCKED
      LIMIT ${EVENT_CLAIM_SWEEP_BATCH_SIZE}
    ),
    deleted AS (
      DELETE FROM processed_events AS pe
      USING expired
      WHERE pe.id = expired.id
        AND pe.status = 'pending'
        AND pe.expires_at <= (SELECT cutoff FROM sweep_clock)
      RETURNING pe.id
    )
    SELECT count(*)::integer AS deleted_count
    FROM deleted
  `);
  const deletedCount = Number(result[0]?.deleted_count ?? 0);
  if (!Number.isInteger(deletedCount) || deletedCount < 0 || deletedCount > EVENT_CLAIM_SWEEP_BATCH_SIZE) {
    throw new Error("expired event claim sweep returned an invalid count");
  }
  return deletedCount;
}

function parseDatabaseDate(value: Date | string, label: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`processed event has an invalid ${label}`);
  }
  return parsed;
}
