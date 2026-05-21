import {
  type AgentChatStatus,
  type AgentEngagement,
  buildAgentChatStatus,
  LIVE_ACTIVITY_STALE_MS,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { derivePendingQuestions } from "./me-chat.js";

/** session_event kinds that mean "producing output right now" (axis D). */
const WORKING_KINDS = new Set(["tool_call", "thinking", "assistant_text"]);

/**
 * Composite per-(agent,chat) status for every non-human speaker in a chat —
 * the server-authoritative aggregation behind `GET /chats/:chatId/agent-status`.
 *
 * Folds the four axes per agent and reduces them via `buildAgentChatStatus`
 * (so `main` is always derived, never hand-set):
 *   - reachability (A): the agent has a bound client (`agent_presence.client_id`)
 *   - engagement   (C): `agent_chat_sessions.state` for this pair
 *   - activity     (D): a fresh, non-terminal latest `session_events` row
 *   - attention       : a pending AskUserQuestion (`pending_questions`)
 */
export async function getChatAgentStatuses(db: Database, chatId: string): Promise<AgentChatStatus[]> {
  // Non-human speaker agents in the chat. Humans don't have runtime status
  // and aren't rendered in the per-agent status surfaces.
  const speakers = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker"), ne(agents.type, "human")));
  const agentIds = speakers.map((s) => s.agentId);
  if (agentIds.length === 0) return [];

  // Per-(agent,chat) session lifecycle (C).
  const sessions = await db
    .select({ agentId: agentChatSessions.agentId, state: agentChatSessions.state })
    .from(agentChatSessions)
    .where(and(eq(agentChatSessions.chatId, chatId), inArray(agentChatSessions.agentId, agentIds)));
  const sessionState = new Map(sessions.map((s) => [s.agentId, s.state]));

  // Reachability (A): a non-null bound client. Mirrors the web
  // `resolveAgentState` rule (no client ⇒ offline).
  const presence = await db
    .select({ agentId: agentPresence.agentId, clientId: agentPresence.clientId })
    .from(agentPresence)
    .where(inArray(agentPresence.agentId, agentIds));
  const reachable = new Map(presence.map((p) => [p.agentId, p.clientId != null]));

  // Attention: agents with a pending AskUserQuestion in this chat.
  const pendingByChat = await derivePendingQuestions(db, [chatId]);
  const pendingAgents = new Set(pendingByChat.get(chatId) ?? []);

  // Activity (D): agents whose latest event is fresh and non-terminal.
  const workingAgents = await deriveWorkingAgents(db, chatId);

  return agentIds.map((agentId) => {
    const state = sessionState.get(agentId);
    const engagement: AgentEngagement = state === "active" ? "active" : state === "suspended" ? "suspended" : "none";
    return buildAgentChatStatus({
      agentId,
      reachable: reachable.get(agentId) ?? false,
      errored: state === "errored",
      needsYou: pendingAgents.has(agentId),
      working: workingAgents.has(agentId),
      engagement,
    });
  });
}

/**
 * Agents in `chatId` whose latest `session_events` row is a fresh
 * (< stale threshold) working kind. Per-pair LATERAL seek on the unique
 * `(agent_id, chat_id, seq)` index — same shape as `deriveLiveActivity`, but
 * resolved per agent rather than collapsed to one per chat.
 */
async function deriveWorkingAgents(db: Database, chatId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT acs.agent_id AS agent_id, e.kind AS kind, e.created_at AS created_at
      FROM agent_chat_sessions acs
      CROSS JOIN LATERAL (
        SELECT kind, created_at, seq
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
         ORDER BY se.seq DESC
         LIMIT 1
      ) e
     WHERE acs.chat_id = ${chatId}
       AND acs.state <> 'evicted'
  `)) as unknown as Array<{ agent_id: string; kind: string; created_at: Date | string }>;
  const now = Date.now();
  const out = new Set<string>();
  for (const r of rows) {
    if (!WORKING_KINDS.has(r.kind)) continue;
    if (now - new Date(r.created_at).getTime() > LIVE_ACTIVITY_STALE_MS) continue;
    out.add(r.agent_id);
  }
  return out;
}
