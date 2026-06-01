import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-agent runtime configuration (server-managed; not the local YAML config).
 *
 * One row per agent. `version` increments on every successful UPDATE
 * (optimistic locking via WHERE version = :expected). Sensitive env values
 * inside `payload.env[*]` are AES-256-GCM encrypted at write time and
 * masked when echoed via the Admin API (see Step 2).
 *
 * Integrity is enforced by the service layer per project convention:
 * no FK / CHECK / triggers on this table.
 */
export const agentConfigs = pgTable("agent_configs", {
  /** PK + logical FK to agents.uuid; the service layer keeps these in sync. */
  agentId: text("agent_id").primaryKey(),
  /** Optimistic-lock version. Starts at 1; never null. */
  version: integer("version").notNull().default(1),
  /** Full encrypted-at-rest payload (5 field groups: prompt/model/mcpServers/env/gitRepos). */
  payload: jsonb("payload").$type<AgentRuntimeConfigPayload>().notNull(),
  /** Member id (or "system" for migration backfill / agent-create insert). */
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
