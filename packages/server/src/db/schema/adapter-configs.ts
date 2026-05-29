import { jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/** Bot credentials for external platform adapters. Credentials are encrypted at application layer (AES-256-GCM). */
export const adapterConfigs = pgTable(
  "adapter_configs",
  {
    id: serial("id").primaryKey(),
    /** Adapter platform identifier (currently "kael"). */
    platform: text("platform").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid),
    /** Encrypted JSONB — application-layer AES-256-GCM */
    credentials: jsonb("credentials").$type<unknown>().notNull(),
    /** "active" | "inactive" */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_adapter_configs_agent_platform").on(t.agentId, t.platform)],
);
