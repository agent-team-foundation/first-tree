import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";

/**
 * Seed an agent_presence row with a known lastSeenAt so heartbeat-touch
 * assertions have a stable baseline. `createAgent` does not auto-insert
 * agent_presence, and `upsertSessionState`'s inner UPDATE is a no-op when
 * no row exists — so tests that read presence fields must seed first.
 */
export async function seedPresence(
  app: FastifyInstance,
  agentId: string,
  lastSeenAt: Date,
  counts: { active?: number; total?: number } = {},
): Promise<void> {
  const activeSessions = counts.active ?? 0;
  const totalSessions = counts.total ?? 0;
  await app.db
    .insert(agentPresence)
    .values({ agentId, lastSeenAt, activeSessions, totalSessions })
    .onConflictDoUpdate({
      target: [agentPresence.agentId],
      set: { lastSeenAt, activeSessions, totalSessions },
    });
}

export async function readPresence(app: FastifyInstance, agentId: string) {
  const [row] = await app.db
    .select({
      lastSeenAt: agentPresence.lastSeenAt,
      activeSessions: agentPresence.activeSessions,
      totalSessions: agentPresence.totalSessions,
    })
    .from(agentPresence)
    .where(eq(agentPresence.agentId, agentId))
    .limit(1);
  return row;
}

export async function readSessionState(app: FastifyInstance, agentId: string, chatId: string): Promise<string | null> {
  const [row] = await app.db
    .select({ state: agentChatSessions.state })
    .from(agentChatSessions)
    .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
    .limit(1);
  return row?.state ?? null;
}
