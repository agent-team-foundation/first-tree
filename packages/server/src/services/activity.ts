import type { SessionState } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { agentVisibilityCondition, type MemberScope } from "./access-control.js";
import type { Notifier } from "./notifier.js";

/**
 * Upsert a session state and update materialized aggregates on agent_presence.
 *
 * `organizationId` is passed through to the PG NOTIFY payload so the admin
 * WS route can filter strictly. Callers already have it in scope (session
 * closure for WS, agent row for tests) — the service deliberately does not
 * re-query `agents` here to keep the hot path SELECT-free.
 */
export async function upsertSessionState(
  db: Database,
  agentId: string,
  chatId: string,
  state: SessionState,
  organizationId: string,
  notifier?: Notifier,
) {
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

    // 2. Aggregate session counts and update presence (session counts only).
    //    runtimeState is NOT written here — the client-reported runtime:state
    //    message is the single authority for runtimeState to avoid dual-write conflicts.
    const [counts] = await tx
      .select({
        active: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} = 'active')::int`,
        total: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} != 'evicted')::int`,
      })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.agentId, agentId));

    const activeSessions = counts?.active ?? 0;
    const totalSessions = counts?.total ?? 0;

    await tx
      .update(agentPresence)
      .set({
        activeSessions,
        totalSessions,
        lastSeenAt: now,
      })
      .where(eq(agentPresence.agentId, agentId));
  });

  // Fire-and-forget PG NOTIFY for session state changes
  if (notifier) {
    notifier.notifySessionStateChange(agentId, chatId, state, organizationId).catch(() => {});
  }
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
      blocked: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'blocked')::int`,
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
      blocked: agentCounts?.blocked ?? 0,
      error: agentCounts?.error ?? 0,
    },
    clients: clientCounts?.count ?? 0,
  };
}

export async function getAgentWithRuntime(db: Database, agentId: string) {
  const [row] = await db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId)).limit(1);
  return row ?? null;
}

/**
 * List agents with active runtime state.
 * When scope is provided, filters to agents visible to the member.
 */
export async function listAgentsWithRuntime(db: Database, scope?: MemberScope) {
  if (!scope) {
    return db.select().from(agentPresence).where(isNotNull(agentPresence.runtimeState));
  }

  // JOIN with agents table to apply visibility filter
  return db
    .select({
      agentId: agentPresence.agentId,
      status: agentPresence.status,
      instanceId: agentPresence.instanceId,
      connectedAt: agentPresence.connectedAt,
      lastSeenAt: agentPresence.lastSeenAt,
      clientId: agentPresence.clientId,
      runtimeType: agentPresence.runtimeType,
      runtimeVersion: agentPresence.runtimeVersion,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
      totalSessions: agentPresence.totalSessions,
      runtimeUpdatedAt: agentPresence.runtimeUpdatedAt,
      type: agents.type,
    })
    .from(agentPresence)
    .innerJoin(agents, eq(agentPresence.agentId, agents.uuid))
    .where(and(isNotNull(agentPresence.runtimeState), agentVisibilityCondition(scope)));
}

/**
 * Clean up stale session rows from agent_chat_sessions.
 * Removes evicted rows older than staleSeconds and suspended rows older than staleSeconds.
 * Returns the number of rows deleted.
 */
export async function cleanupStaleSessions(db: Database, staleSeconds = 604_800): Promise<number> {
  const result = await db.execute<{ cnt: number }>(sql`
    WITH deleted AS (
      DELETE FROM agent_chat_sessions
      WHERE state IN ('evicted', 'suspended')
      AND updated_at < NOW() - make_interval(secs => ${staleSeconds})
      RETURNING 1
    )
    SELECT count(*)::int AS cnt FROM deleted
  `);
  return result[0]?.cnt ?? 0;
}
