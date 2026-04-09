import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/** Agent bearer tokens. Multiple tokens can coexist for zero-downtime rotation. */
export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    /** SHA-256 hash; plaintext is returned only once at creation */
    tokenHash: text("token_hash").notNull(),
    /** Optional label, e.g. "production", "dev" */
    name: text("name"),
    /** NULL = never expires */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Non-NULL means revoked */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("idx_agent_tokens_agent").on(table.agentId), index("idx_agent_tokens_hash").on(table.tokenHash)],
);
