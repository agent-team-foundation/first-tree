import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Runtime system configuration (key-value JSONB). Dynamically modifiable via Admin API; controls inbox timeout, retry count, etc. */
export const systemConfigs = pgTable("system_configs", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
