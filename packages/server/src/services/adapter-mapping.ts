import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

// ── Event deduplication ─────────────────────────────────────────────

/**
 * Attempt to claim an event for processing.
 * Returns true if this is the first time the event is seen, false if duplicate.
 */
export async function claimEvent(db: Database, eventId: string, platform: string): Promise<boolean> {
  const result = await db.execute<{ event_id: string }>(
    sql`INSERT INTO processed_events (event_id, platform) VALUES (${eventId}, ${platform}) ON CONFLICT DO NOTHING RETURNING event_id`,
  );
  return result.length > 0;
}

/**
 * Remove a claimed event so it can be retried on next delivery.
 * Called when processing fails after claimEvent() succeeded.
 */
export async function unclaimEvent(db: Database, eventId: string, platform: string): Promise<void> {
  await db.execute(sql`DELETE FROM processed_events WHERE event_id = ${eventId} AND platform = ${platform}`);
}
