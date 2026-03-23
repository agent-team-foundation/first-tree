import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Webhook event deduplication.
 * Multiple bots in the same group chat receive the same event from Feishu,
 * so we use INSERT ... ON CONFLICT DO NOTHING to ensure single processing.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_processed_event").on(table.eventId, table.platform)],
);
