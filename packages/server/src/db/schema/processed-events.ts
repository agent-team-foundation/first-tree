import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Webhook event deduplication. External webhook sources (e.g. GitHub) can
 * deliver the same event multiple times; claims use an atomic
 * INSERT ... ON CONFLICT to ensure single processing.
 *
 * Claim lifecycle (issue #317): a dispatch inserts `status='pending'` with
 * `expires_at` = claim time + TTL; a successfully completed handler marks
 * the row `done`. Redeliveries dedupe only against `done` claims — an
 * expired `pending` claim is taken over atomically or removed by the
 * background sweep, so a crash between claim and completion can no longer
 * lose the event forever.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    platform: text("platform").notNull(),
    status: text("status").$type<"pending" | "done">().notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("uq_processed_event").on(table.eventId, table.platform)],
);
