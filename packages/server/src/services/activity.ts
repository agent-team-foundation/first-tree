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
 * Upsert session state + refresh presence aggregates + NOTIFY.
 *
 * `agent_chat_sessions.(agent_id, chat_id)` is a single-row "current session
 * state" cache, not a session history log. A new runtime session starting on
 * the same (agent, chat) pair MUST overwrite whatever ended before — including
 * an `evicted` row left by a previous terminate. The previous "revival
 * defense" conflated two concerns: "this runtime session ended" (which is
 * what `evicted` actually means) and "this chat is permanently archived for
 * this agent" (a chat-level decision that should live on `chats`, not here).
 * See proposals/hub-agent-messaging-reply-and-mentions §M2-session-lifecycle.
 */
export async function upsertSessionState(
  db: Database,
  agentId: string,
  chatId: string,
  state: SessionState,
  organizationId: string,
  notifier?: Notifier,
  options?: { touchPresenceLastSeen?: boolean },
) {
  const now = new Date();
  let wrote = false;
  await db.transaction(async (tx) => {
    await tx
      .insert(agentChatSessions)
      .values({ agentId, chatId, state, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state, updatedAt: now },
      });

    // runtimeState is owned by the client's `runtime:state` frame — do not
    // write it here to avoid dual-write conflicts.
    const [counts] = await tx
      .select({
        active: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} = 'active')::int`,
        total: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} != 'evicted')::int`,
      })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.agentId, agentId));

    const activeSessions = counts?.active ?? 0;
    const totalSessions = counts?.total ?? 0;

    // `lastSeenAt` is owned by the client's bind/heartbeat. Skip it on
    // server-predictive writes (e.g. sendMessage upserting active on first
    // message); default-true preserves the WS `session:state` path's behavior.
    const touchLastSeen = options?.touchPresenceLastSeen ?? true;
    const presenceSet = touchLastSeen
      ? { activeSessions, totalSessions, lastSeenAt: now }
      : { activeSessions, totalSessions };

    await tx.update(agentPresence).set(presenceSet).where(eq(agentPresence.agentId, agentId));

    wrote = true;
  });

  if (wrote && notifier) {
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
