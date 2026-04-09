import type { AgentActivity } from "@first-tree-hub/shared";
import { eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { clients } from "../db/schema/clients.js";

export async function updateActivity(db: Database, agentId: string, activity: AgentActivity) {
  const now = new Date();
  await db
    .update(agentPresence)
    .set({
      runtimeState: activity.state,
      runtimeDescription: activity.description ?? null,
      activeSessions: activity.activeSessions ?? null,
      totalSessions: activity.totalSessions ?? null,
      errorMessage: activity.errorMessage ?? null,
      taskRef: activity.taskRef ?? null,
      runtimeUpdatedAt: now,
      lastSeenAt: now,
    })
    .where(eq(agentPresence.agentId, agentId));
}

export async function resetActivity(db: Database, agentId: string) {
  const now = new Date();
  await db
    .update(agentPresence)
    .set({
      runtimeState: "idle",
      runtimeDescription: null,
      errorMessage: null,
      taskRef: null,
      runtimeUpdatedAt: now,
    })
    .where(eq(agentPresence.agentId, agentId));
}

export async function getActivityOverview(db: Database) {
  const [agentCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      running: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} IS NOT NULL)::int`,
      idle: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'idle')::int`,
      working: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'working')::int`,
      error: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'error')::int`,
    })
    .from(agentPresence);

  const [clientCounts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clients)
    .where(eq(clients.status, "connected"));

  return {
    total: agentCounts?.total ?? 0,
    running: agentCounts?.running ?? 0,
    byState: {
      idle: agentCounts?.idle ?? 0,
      working: agentCounts?.working ?? 0,
      error: agentCounts?.error ?? 0,
    },
    clients: clientCounts?.count ?? 0,
  };
}

export async function getAgentWithRuntime(db: Database, agentId: string) {
  const [row] = await db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId)).limit(1);
  return row ?? null;
}

export async function listAgentsWithRuntime(db: Database) {
  return db.select().from(agentPresence).where(isNotNull(agentPresence.runtimeState));
}
