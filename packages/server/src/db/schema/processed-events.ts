import { sql } from "drizzle-orm";
import { index, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Webhook event deduplication with a claim lease. External webhook sources
 * (e.g. GitHub) can deliver the same event multiple times. Each delivery is
 * claimed as `pending` with an expiry before processing and marked `done`
 * after its side effects landed. A redelivery of an expired `pending` claim
 * (crashed or wedged attempt) takes the claim over instead of being deduped,
 * so a crash between claim and completion no longer loses the event; `done`
 * rows dedupe forever. `claim_token` scopes complete/release to the attempt
 * that actually holds the claim. Rows predating the lease columns carry the
 * `done` default: they were recorded by code that only inserted after-the-fact
 * dedupe markers, and they keep deduping forever.
 *
 * NOTE: this table predates drizzle-kit management — it was created by
 * migration 0003 and is deliberately not exported from `./index.ts`, so it
 * is absent from the drizzle snapshots. Schema changes here need a custom
 * migration (`drizzle-kit generate --custom`, see 0082 / the 0046 and 0053
 * precedents); a plain `db:generate` cannot diff this table.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<"pending" | "done">().notNull().default("done"),
    /** Set while `pending`; NULL once `done`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Owning attempt (UUID v7) while `pending`; NULL once `done`. */
    claimToken: text("claim_token"),
  },
  (table) => [
    unique("uq_processed_event").on(table.eventId, table.platform),
    index("idx_processed_events_pending").on(table.expiresAt).where(sql`status = 'pending'`),
  ],
);
