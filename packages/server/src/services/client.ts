import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { clients } from "../db/schema/clients.js";
import { runtimeFieldsReset } from "./presence.js";

export async function registerClient(
  db: Database,
  data: {
    clientId: string;
    instanceId: string;
    hostname?: string;
    os?: string;
    sdkVersion?: string;
  },
) {
  const now = new Date();
  await db
    .insert(clients)
    .values({
      id: data.clientId,
      status: "connected",
      instanceId: data.instanceId,
      hostname: data.hostname ?? null,
      os: data.os ?? null,
      sdkVersion: data.sdkVersion ?? null,
      connectedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: clients.id,
      set: {
        status: "connected",
        instanceId: data.instanceId,
        hostname: data.hostname ?? null,
        os: data.os ?? null,
        sdkVersion: data.sdkVersion ?? null,
        connectedAt: now,
        lastSeenAt: now,
      },
    });
}

export async function disconnectClient(db: Database, clientId: string) {
  const now = new Date();

  // Only reset agents still bound to this client.
  // Agents that were re-bound to a different client must not be affected.
  await db
    .update(agentPresence)
    .set({ status: "offline", clientId: null, ...runtimeFieldsReset(now) })
    .where(eq(agentPresence.clientId, clientId));

  await db.update(clients).set({ status: "disconnected", lastSeenAt: now }).where(eq(clients.id, clientId));
}

export async function heartbeatClient(db: Database, clientId: string) {
  await db.update(clients).set({ lastSeenAt: new Date() }).where(eq(clients.id, clientId));
}

export async function getClient(db: Database, clientId: string) {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  return row ?? null;
}

export async function listClients(db: Database) {
  const rows = await db.select().from(clients).where(eq(clients.status, "connected"));
  // Attach agent counts
  const counts = await db
    .select({
      clientId: agentPresence.clientId,
      count: sql<number>`count(*)::int`,
    })
    .from(agentPresence)
    .where(sql`${agentPresence.clientId} IS NOT NULL AND ${agentPresence.runtimeState} IS NOT NULL`)
    .groupBy(agentPresence.clientId);

  const countMap = new Map(counts.map((c) => [c.clientId, c.count]));

  return rows.map((row) => ({
    ...row,
    agentCount: countMap.get(row.id) ?? 0,
  }));
}

export async function cleanupStaleClients(db: Database, staleSeconds = 60): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE clients SET status = 'disconnected'
    WHERE instance_id IN (
      SELECT instance_id FROM server_instances
      WHERE last_heartbeat < NOW() - make_interval(secs => ${staleSeconds})
    )
    AND status = 'connected'
    RETURNING id
  `);

  if (result.length > 0) {
    const staleIds = result.map((r) => r.id);
    await db
      .update(agentPresence)
      .set({
        status: "offline",
        runtimeState: null,
        activeSessions: null,
        totalSessions: null,
        runtimeUpdatedAt: new Date(),
      })
      .where(inArray(agentPresence.clientId, staleIds));
  }

  return result.length;
}
