import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { serverInstances } from "../db/schema/server-instances.js";

/** Common field reset when agent goes offline or is unbound. */
export function runtimeFieldsReset(now: Date) {
  return {
    runtimeState: null,
    runtimeDescription: null,
    activeSessions: null,
    totalSessions: null,
    errorMessage: null,
    taskRef: null,
    runtimeUpdatedAt: now,
    lastSeenAt: now,
  } as const;
}

// -- Legacy presence (kept for backward compat + non-M1 clients) --

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
  const now = new Date();
  await db
    .update(agentPresence)
    .set({
      status: "offline",
      instanceId: null,
      ...runtimeFieldsReset(now),
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

// -- M1: Agent bind/unbind (client-aware) --

export async function bindAgent(
  db: Database,
  agentId: string,
  data: {
    clientId: string;
    instanceId: string;
    runtimeType: string;
    runtimeVersion?: string;
  },
) {
  const now = new Date();
  await db
    .insert(agentPresence)
    .values({
      agentId,
      status: "online",
      instanceId: data.instanceId,
      clientId: data.clientId,
      runtimeType: data.runtimeType,
      runtimeVersion: data.runtimeVersion ?? null,
      runtimeState: "idle",
      connectedAt: now,
      lastSeenAt: now,
      runtimeUpdatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentPresence.agentId,
      set: {
        status: "online",
        instanceId: data.instanceId,
        clientId: data.clientId,
        runtimeType: data.runtimeType,
        runtimeVersion: data.runtimeVersion ?? null,
        runtimeState: "idle",
        runtimeDescription: null,
        activeSessions: null,
        totalSessions: null,
        errorMessage: null,
        taskRef: null,
        connectedAt: now,
        lastSeenAt: now,
        runtimeUpdatedAt: now,
      },
    });
}

export async function unbindAgent(db: Database, agentId: string) {
  const now = new Date();
  await db
    .update(agentPresence)
    .set({
      status: "offline",
      clientId: null,
      ...runtimeFieldsReset(now),
    })
    .where(eq(agentPresence.agentId, agentId));
}

// -- Server instance heartbeat --

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
    UPDATE agent_presence SET status = 'offline', instance_id = NULL,
      runtime_state = NULL, runtime_description = NULL,
      active_sessions = NULL, total_sessions = NULL,
      error_message = NULL, task_ref = NULL,
      runtime_updated_at = NOW()
    WHERE instance_id IN (
      SELECT instance_id FROM server_instances
      WHERE last_heartbeat < NOW() - make_interval(secs => ${staleSeconds})
    )
    AND status = 'online'
    RETURNING agent_id
  `);
  return result.length;
}
