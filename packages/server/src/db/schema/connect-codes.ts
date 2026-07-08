import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Short-lived login codes surfaced by `POST /me/connect-tokens`.
 *
 * The public token is `<issuer>/connect/<code>`, where the URL origin keeps the
 * CLI's prod/staging/dev routing property. Only a hash of the opaque code is
 * stored here, then consumed atomically on exchange. Rows are retained after
 * consumption/expiry for short-term audit; a future cleanup task can delete old
 * consumed/expired rows.
 */
export const connectCodes = pgTable(
  "connect_codes",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_connect_codes_user").on(table.userId),
    index("idx_connect_codes_expires_at").on(table.expiresAt),
  ],
);
