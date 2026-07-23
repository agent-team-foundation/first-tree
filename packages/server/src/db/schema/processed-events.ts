import { index, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Webhook event deduplication with a claim lifecycle.
 *
 * External webhook sources (e.g. GitHub) can deliver the same event multiple
 * times. A delivery is claimed with `status = 'pending'` plus an expiry before
 * any side effects run, and flipped to `status = 'done'` once the handler
 * completes. Redeliveries are deduped against `done` claims (and unexpired
 * in-flight `pending` claims); an expired `pending` claim is taken over
 * atomically, so a crash between claim and completion can never lose the
 * event forever.
 *
 * The column default is `'done'` so rows that predate the lifecycle keep
 * deduping after the migration backfill. Live code always sets `status`
 * explicitly.
 *
 * NOTE: this table predates drizzle-kit management (created by the
 * hand-written 0003_feishu_adapter.sql) and is deliberately NOT exported
 * from schema/index.ts — a regular `db:generate` would emit a conflicting
 * CREATE TABLE. Schema changes ship as `drizzle-kit generate --custom`
 * migrations (see 0084); keep this file in sync as documentation parity.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    platform: text("platform").notNull(),
    status: text("status").notNull().default("done"),
    /** Expiry for `pending` claims; `null` once the claim is `done`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_processed_event").on(table.eventId, table.platform),
    index("idx_processed_events_status_expires").on(table.status, table.expiresAt),
  ],
);
