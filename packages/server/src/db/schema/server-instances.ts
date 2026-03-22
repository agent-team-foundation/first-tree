import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Server instance heartbeat. Used to detect crashed instances and clean up associated agent_presence records. */
export const serverInstances = pgTable("server_instances", {
  instanceId: text("instance_id").primaryKey(),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).notNull().defaultNow(),
});
