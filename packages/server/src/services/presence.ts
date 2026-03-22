import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { serverInstances } from "../db/schema/server-instances.js";

export async function setOnline(db: Database, agentId: string, instanceId: string) {
  const now = new Date();
  await db
    .insert(agentPresence)
    .values({
      agentId,
      status: "online",
      instanceId,
      connectedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: agentPresence.agentId,
      set: {
        status: "online",
        instanceId,
        connectedAt: now,
        lastSeenAt: now,
      },
    });
}

export async function setOffline(db: Database, agentId: string) {
  await db
    .update(agentPresence)
    .set({
      status: "offline",
      instanceId: null,
      lastSeenAt: new Date(),
    })
    .where(eq(agentPresence.agentId, agentId));
}

export async function getPresence(db: Database, agentId: string) {
  const [row] = await db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId)).limit(1);
  return row ?? null;
}

export async function getOnlineCount(db: Database): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentPresence)
    .where(eq(agentPresence.status, "online"));
  return result?.count ?? 0;
}

export async function heartbeatInstance(db: Database, instanceId: string) {
  await db
    .insert(serverInstances)
    .values({ instanceId, lastHeartbeat: new Date() })
    .onConflictDoUpdate({
      target: serverInstances.instanceId,
      set: { lastHeartbeat: new Date() },
    });
}

export async function cleanupStalePresence(db: Database, staleSeconds = 60): Promise<number> {
  const result = await db.execute<{ agent_id: string }>(sql`
    UPDATE agent_presence SET status = 'offline', instance_id = NULL
    WHERE instance_id IN (
      SELECT instance_id FROM server_instances
      WHERE last_heartbeat < NOW() - make_interval(secs => ${staleSeconds})
    )
    AND status = 'online'
    RETURNING agent_id
  `);
  return result.length;
}
