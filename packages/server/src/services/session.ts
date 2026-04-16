import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { NotFoundError } from "../errors.js";

export type SessionListItem = {
  agentId: string;
  chatId: string;
  state: string;
  runtimeState: string | null;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
};

/** List sessions for a specific agent, with optional state filters. */
export async function listAgentSessions(
  db: Database,
  agentId: string,
  filters?: { state?: string; runtimeState?: string },
): Promise<SessionListItem[]> {
  const conditions = [eq(agentChatSessions.agentId, agentId)];
  if (filters?.state) {
    conditions.push(eq(agentChatSessions.state, filters.state));
  }

  const rows = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      updatedAt: agentChatSessions.updatedAt,
      chatCreatedAt: chats.createdAt,
    })
    .from(agentChatSessions)
    .innerJoin(chats, eq(agentChatSessions.chatId, chats.id))
    .where(and(...conditions))
    .orderBy(desc(agentChatSessions.updatedAt));

  // Get the agent's runtimeState once (it's agent-level, not per-session)
  const [presence] = await db
    .select({ runtimeState: agentPresence.runtimeState })
    .from(agentPresence)
    .where(eq(agentPresence.agentId, agentId))
    .limit(1);

  const agentRuntimeState = presence?.runtimeState ?? null;

  // Filter by runtimeState if requested (agent-level filter)
  if (filters?.runtimeState && agentRuntimeState !== filters.runtimeState) {
    return [];
  }

  // Get message counts per chat in a single query
  const chatIds = rows.map((r) => r.chatId);
  const messageCounts =
    chatIds.length > 0
      ? await db
          .select({
            chatId: inboxEntries.chatId,
            count: sql<number>`count(*)::int`,
          })
          .from(inboxEntries)
          .where(
            and(
              eq(inboxEntries.inboxId, sql`(SELECT inbox_id FROM agents WHERE uuid = ${agentId})`),
              inArray(inboxEntries.chatId, chatIds),
            ),
          )
          .groupBy(inboxEntries.chatId)
      : [];

  const countMap = new Map(messageCounts.map((r) => [r.chatId, r.count]));

  return rows.map((r) => ({
    agentId: r.agentId,
    chatId: r.chatId,
    state: r.state,
    runtimeState: agentRuntimeState,
    startedAt: r.chatCreatedAt.toISOString(),
    lastActivityAt: r.updatedAt.toISOString(),
    messageCount: countMap.get(r.chatId) ?? 0,
  }));
}

/** Get a single session's detail. */
export async function getSession(db: Database, agentId: string, chatId: string): Promise<SessionListItem> {
  const [row] = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      updatedAt: agentChatSessions.updatedAt,
      chatCreatedAt: chats.createdAt,
    })
    .from(agentChatSessions)
    .innerJoin(chats, eq(agentChatSessions.chatId, chats.id))
    .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
    .limit(1);

  if (!row) throw new NotFoundError(`Session (${agentId}, ${chatId}) not found`);

  const [presence] = await db
    .select({ runtimeState: agentPresence.runtimeState })
    .from(agentPresence)
    .where(eq(agentPresence.agentId, agentId))
    .limit(1);

  // Count inbox entries for this session
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inboxEntries)
    .where(
      and(
        eq(inboxEntries.inboxId, sql`(SELECT inbox_id FROM agents WHERE uuid = ${agentId})`),
        eq(inboxEntries.chatId, chatId),
      ),
    );

  return {
    agentId: row.agentId,
    chatId: row.chatId,
    state: row.state,
    runtimeState: presence?.runtimeState ?? null,
    startedAt: row.chatCreatedAt.toISOString(),
    lastActivityAt: row.updatedAt.toISOString(),
    messageCount: countRow?.count ?? 0,
  };
}

/** List all sessions across all agents, with pagination. Scoped to organization. */
export async function listAllSessions(
  db: Database,
  limit: number,
  cursor?: string,
  filters?: { state?: string; agentId?: string; organizationId?: string },
): Promise<{ items: SessionListItem[]; nextCursor: string | null }> {
  const conditions = [];
  if (filters?.state) {
    conditions.push(eq(agentChatSessions.state, filters.state));
  }
  if (filters?.agentId) {
    conditions.push(eq(agentChatSessions.agentId, filters.agentId));
  }
  if (filters?.organizationId) {
    conditions.push(eq(agents.organizationId, filters.organizationId));
  }
  if (cursor) {
    conditions.push(sql`${agentChatSessions.updatedAt} < ${new Date(cursor)}`);
  }

  const rows = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      updatedAt: agentChatSessions.updatedAt,
      chatCreatedAt: chats.createdAt,
    })
    .from(agentChatSessions)
    .innerJoin(chats, eq(agentChatSessions.chatId, chats.id))
    .innerJoin(agents, eq(agentChatSessions.agentId, agents.uuid))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentChatSessions.updatedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  // Batch-fetch runtimeState for all unique agents
  const agentIds = [...new Set(items.map((r) => r.agentId))];
  const presenceRows =
    agentIds.length > 0
      ? await db
          .select({ agentId: agentPresence.agentId, runtimeState: agentPresence.runtimeState })
          .from(agentPresence)
          .where(inArray(agentPresence.agentId, agentIds))
      : [];
  const runtimeMap = new Map(presenceRows.map((r) => [r.agentId, r.runtimeState]));

  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.updatedAt.toISOString() : null;

  return {
    items: items.map((r) => ({
      agentId: r.agentId,
      chatId: r.chatId,
      state: r.state,
      runtimeState: runtimeMap.get(r.agentId) ?? null,
      startedAt: r.chatCreatedAt.toISOString(),
      lastActivityAt: r.updatedAt.toISOString(),
      messageCount: 0, // Omit per-session message count in global list for performance
    })),
    nextCursor,
  };
}
