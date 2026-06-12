import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One-time token consumption ledger (currently: connect-token JTIs).
 *
 * Replay protection for single-use tokens must hold across server instances
 * and restarts — the previous in-process `Map` only protected replays that
 * hit the same process, so a token could be exchanged once per instance
 * behind a load balancer (and once more after every restart). Consumption is
 * an atomic `INSERT … ON CONFLICT DO NOTHING`: the request that inserts the
 * row wins; any other request carrying the same JTI loses the conflict and
 * is rejected, with PostgreSQL serializing the race.
 *
 * Rows are dead weight once the underlying token has expired (an expired
 * token fails `jwtVerify` before the ledger is consulted), so the background
 * sweeper deletes rows past `expires_at` — see services/background-tasks.ts.
 */
export const consumedTokenIds = pgTable(
  "consumed_token_ids",
  {
    /** The token's `jti` claim (a UUID minted at token creation). */
    jti: text("jti").primaryKey(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The token's own expiry. After this instant the row is unreachable
     * (verification rejects the expired token first) and the sweeper may
     * delete it.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_consumed_token_ids_expires_at").on(table.expiresAt)],
);
