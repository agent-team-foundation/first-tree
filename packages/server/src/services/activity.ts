import type { SessionState } from "@agent-team-foundation/first-tree-hub-shared";
import { eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { clients } from "../db/schema/clients.js";

/** Upsert a session state and update materialized aggregates on agent_presence. */
export async function upsertSessionState(db: Database, agentId: string, chatId: string, state: SessionState) {
  const now = new Date();
  await db.transaction(async (tx) => {
    // 1. Upsert session row
    await tx
      .insert(agentChatSessions)
      .values({ agentId, chatId, state, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state, updatedAt: now },
      });

    // 2. Aggregate and update presence
    const [counts] = await tx
      .select({
        active: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} = 'active')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.agentId, agentId));

    const activeSessions = counts?.active ?? 0;
    const totalSessions = counts?.total ?? 0;
    const runtimeState = activeSessions > 0 ? "working" : "idle";

    await tx
      .update(agentPresence)
      .set({
        runtimeState,
        activeSessions,
        totalSessions,
        runtimeUpdatedAt: now,
        lastSeenAt: now,
      })
      .where(eq(agentPresence.agentId, agentId));
  });
}

export async function resetActivity(db: Database, agentId: string) {
  const now = new Date();
  await db
    .update(agentPresence)
    .set({
      runtimeState: "idle",
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
