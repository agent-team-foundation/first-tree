import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    name: text("name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("idx_agent_tokens_agent").on(table.agentId), index("idx_agent_tokens_hash").on(table.tokenHash)],
);
