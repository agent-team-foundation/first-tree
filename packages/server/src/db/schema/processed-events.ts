import { sql } from "drizzle-orm";
import { check, index, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

export type ProcessedEventStatus = "pending" | "done";

/**
 * Durable webhook claim lifecycle. This legacy table is intentionally kept
 * out of schema/index.ts because it was introduced by custom SQL rather than
 * the Drizzle snapshot lineage.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<ProcessedEventStatus>().notNull().default("done"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_processed_event").on(table.eventId, table.platform),
    index("idx_processed_events_pending_expiry").on(table.expiresAt, table.id).where(sql`${table.status} = 'pending'`),
    check(
      "ck_processed_events_lifecycle",
      sql`(${table.status} = 'pending' AND ${table.expiresAt} IS NOT NULL) OR (${table.status} = 'done' AND ${table.expiresAt} IS NULL)`,
    ),
  ],
);
