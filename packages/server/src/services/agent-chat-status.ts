import {
  type AgentChatStatus,
  type AgentEngagement,
  buildAgentChatStatus,
  LIVE_ACTIVITY_STALE_MS,
  type LiveActivity,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { derivePendingQuestions, previewAssistantText, toLiveActivity } from "./me-chat.js";

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

  // Reachability (A): a non-null bound client (mirrors the web
  // `resolveAgentState` rule — no client ⇒ offline). Also carries the
  // agent-global runtime_state so a runtime `error` folds into `errored`
  // (failed = session errored OR runtime error, §1.2). ONLY `error` is
  // taken from runtime — `working`/`blocked`/`idle` stay out of the per-chat
  // composite (working is driven by live activity D, not global runtime).
  const presence = await db
    .select({
      agentId: agentPresence.agentId,
      clientId: agentPresence.clientId,
      runtimeState: agentPresence.runtimeState,
    })
    .from(agentPresence)
    .where(inArray(agentPresence.agentId, agentIds));
  const presenceById = new Map(presence.map((p) => [p.agentId, p]));

  // Attention: agents with a pending AskUserQuestion in this chat.
  const pendingByChat = await derivePendingQuestions(db, [chatId]);
  const pendingAgents = new Set(pendingByChat.get(chatId) ?? []);

  // Activity (D): per-agent live activity (fresh, non-terminal latest event).
  // `working` is derived from its presence; the activity itself rides along so
  // AgentRow / compose can render the "Using <tool> · 12s" detail.
  const activityByAgent = await deriveAgentActivity(db, chatId);

  return agentIds.map((agentId) => {
    const state = sessionState.get(agentId);
    const p = presenceById.get(agentId);
    const activity = activityByAgent.get(agentId) ?? null;
    const engagement: AgentEngagement = state === "active" ? "active" : state === "suspended" ? "suspended" : "none";
    return buildAgentChatStatus({
      agentId,
      reachable: p?.clientId != null,
      // `failed` predicate: session errored OR runtime error. The chat-list
      // path mirrors this as a SQL clause in `deriveFailedAgents` (me-chat.ts)
      // — keep the two in lockstep if either changes (covered by tests).
      // When the failed causes grow from 2 to ≥3 (e.g. "deadline expired" /
      // "presence stale"), stop relying on this cross-ref + test pinning and
      // extract a shared `FailedReason` (TS predicate + mirrored Drizzle
      // builder) so both surfaces derive from one source. At 2 reasons that
      // indirection costs more than it saves, so we keep the duplicated literal.
      errored: state === "errored" || p?.runtimeState === "error",
      needsYou: pendingAgents.has(agentId),
      working: activity != null,
      engagement,
      activity,
    });
  });
}

/**
 * Sticky narration for a working agent's live activity. Surfaces the current
 * turn's latest `assistant_text` (what the agent is *saying*) on `turnText` so
 * the compose status bar keeps showing the narration even after a `tool_call`
 * arrives — without it the activity is the single newest event, and a tool call
 * fired right after a sentence buries the prose. Leaves `turnText` absent (base
 * activity unchanged) when the turn has produced no prose yet. Base `kind` /
 * `label` are preserved, so the sidebar AgentRow and chat-list chip keep
 * reading `Using <tool>`. Pure & exported for unit testing.
 */
export function withTurnNarration(base: LiveActivity | null, narrationText: unknown): LiveActivity | null {
  if (!base) return null;
  const narration = previewAssistantText(narrationText);
  return narration ? { ...base, turnText: narration } : base;
}

/**
 * Per-agent live activity in `chatId`: the latest `session_events` row per
 * pair, mapped through `toLiveActivity` (so terminal kinds → absent) and
 * dropped when older than the stale threshold. Per-pair LATERAL seek on the
 * unique `(agent_id, chat_id, seq)` index — the same shape as
 * `deriveLiveActivity`, resolved per agent rather than collapsed per chat.
 *
 * A second LATERAL seeks the current turn's latest `assistant_text` (seq past
 * the last `turn_end`); `withTurnNarration` rides it along as `turnText` so the
 * compose status bar can show the running narration even while a tool runs.
 * Only this focused single-chat status query pays for the extra seek; the
 * chat-list `deriveLiveActivity` is unchanged.
 */
async function deriveAgentActivity(db: Database, chatId: string): Promise<Map<string, LiveActivity>> {
  const rows = (await db.execute(sql`
    SELECT acs.agent_id AS agent_id,
           e.kind AS kind, e.payload AS payload, e.created_at AS created_at,
           t.text AS turn_text
      FROM agent_chat_sessions acs
      CROSS JOIN LATERAL (
        SELECT kind, payload, created_at, seq
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
         ORDER BY se.seq DESC
         LIMIT 1
      ) e
      LEFT JOIN LATERAL (
        SELECT LEFT(se.payload->>'text', 200) AS text
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
           AND se.kind     = 'assistant_text'
           AND se.seq > COALESCE((
             SELECT MAX(se2.seq)
               FROM session_events se2
              WHERE se2.agent_id = acs.agent_id
                AND se2.chat_id  = acs.chat_id
                AND se2.kind     = 'turn_end'
           ), 0)
         ORDER BY se.seq DESC
         LIMIT 1
      ) t ON TRUE
     WHERE acs.chat_id = ${chatId}
       AND acs.state <> 'evicted'
  `)) as unknown as Array<{
    agent_id: string;
    kind: string;
    payload: unknown;
    created_at: Date | string;
    turn_text: string | null;
  }>;
  const now = Date.now();
  const out = new Map<string, LiveActivity>();
  for (const r of rows) {
    if (now - new Date(r.created_at).getTime() > LIVE_ACTIVITY_STALE_MS) continue;
    const base = toLiveActivity({
      agent_id: r.agent_id,
      chat_id: chatId,
      kind: r.kind,
      payload: r.payload,
      created_at: r.created_at,
    });
    const activity = withTurnNarration(base, r.turn_text);
    if (activity) out.set(r.agent_id, activity);
  }
  return out;
}
