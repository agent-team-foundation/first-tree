import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const serverInstances = pgTable("server_instances", {
  instanceId: text("instance_id").primaryKey(),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).notNull().defaultNow(),
});
