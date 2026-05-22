import { index, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Webhook event deduplication.
 *
 * Multiple bots in the same group chat receive the same event from Feishu,
 * so we use INSERT ... ON CONFLICT DO NOTHING to ensure single processing.
 *
 * Retention: rows are deleted by `pruneProcessedEvents` (background task)
 * after `processedEventsRetentionSeconds` (default 30 days). The
 * `idx_processed_events_created_at` btree supports that DELETE's WHERE
 * scan so cleanup stays a tiny operation once the table is in steady
 * state. See #509.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_processed_event").on(table.eventId, table.platform),
    index("idx_processed_events_created_at").on(table.createdAt),
  ],
);
