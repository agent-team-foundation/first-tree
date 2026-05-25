import type { RuntimeState } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { serverInstances } from "../db/schema/server-instances.js";
import type { Notifier } from "./notifier.js";

/** Common field reset when agent goes offline or is unbound. */
export function runtimeFieldsReset(now: Date) {
  return {
    runtimeState: null,
    activeSessions: null,
    totalSessions: null,
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
        activeSessions: null,
        totalSessions: null,
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

/** Set runtime state directly from client-reported value.
 *
 * When an org-scoped notifier is provided, emit a PG NOTIFY on the
 * `runtime_state_changes` channel so the pulse aggregator (and any future
 * admin-side consumers) can observe the transition. Fire-and-forget to match
 * notifier semantics elsewhere in this module. */
export async function setRuntimeState(
  db: Database,
  agentId: string,
  runtimeState: RuntimeState,
  options?: { organizationId?: string; notifier?: Notifier },
): Promise<void> {
  const now = new Date();
  await db
    .update(agentPresence)
    .set({ runtimeState, runtimeUpdatedAt: now, lastSeenAt: now })
    .where(eq(agentPresence.agentId, agentId));
  if (options?.notifier && options.organizationId) {
    options.notifier.notifyRuntimeStateChange(agentId, runtimeState, options.organizationId).catch(() => {});
  }
}

/** Touch agent last_seen_at on heartbeat (per-agent liveness). */
export async function touchAgent(db: Database, agentId: string): Promise<void> {
  await db.update(agentPresence).set({ lastSeenAt: new Date() }).where(eq(agentPresence.agentId, agentId));
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

/**
 * M1: Mark agents as offline whose last_seen_at is older than staleSeconds.
 * Unlike cleanupStalePresence (which checks instance liveness), this checks
 * per-agent heartbeat liveness — detecting agents that stopped heartbeating
 * while the client process may still be alive.
 *
 * Returns the list of agent IDs that were marked stale (for notification in Step 6).
 */
export async function markStaleAgents(db: Database, staleSeconds = 60): Promise<string[]> {
  const result = await db.execute<{ agent_id: string }>(sql`
    UPDATE agent_presence SET
      status = 'offline',
      client_id = NULL,
      runtime_state = NULL,
      active_sessions = NULL,
      total_sessions = NULL,
      runtime_updated_at = NOW()
    WHERE status = 'online'
    AND last_seen_at < NOW() - make_interval(secs => ${staleSeconds})
    RETURNING agent_id
  `);
  return result.map((r) => r.agent_id);
}

export async function cleanupStalePresence(db: Database, staleSeconds = 60): Promise<number> {
  const result = await db.execute<{ agent_id: string }>(sql`
    UPDATE agent_presence SET status = 'offline', instance_id = NULL,
      runtime_state = NULL,
      active_sessions = NULL, total_sessions = NULL,
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
