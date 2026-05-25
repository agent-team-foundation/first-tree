import {
  type AgentChatStatus,
  type AgentEngagement,
  buildAgentChatStatus,
  LIVE_ACTIVITY_STALE_MS,
  type LiveActivity,
  RUNTIME_STALE_MS,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { derivePendingQuestions, toLiveActivity } from "./me-chat.js";

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

  // Per-(agent,chat) session lifecycle (C) + the per-chat D-axis runtime state.
  // `runtimeStateAt` is the authority/fallback discriminator: non-null means a
  // client has reported per-chat runtime, so `working` reads it directly; null
  // means an old client that only reports agent-global runtime, so `working`
  // falls back to the legacy `session_events` proxy (one release cycle).
  const sessions = await db
    .select({
      agentId: agentChatSessions.agentId,
      state: agentChatSessions.state,
      runtimeState: agentChatSessions.runtimeState,
      runtimeStateAt: agentChatSessions.runtimeStateAt,
    })
    .from(agentChatSessions)
    .where(and(eq(agentChatSessions.chatId, chatId), inArray(agentChatSessions.agentId, agentIds)));
  const sessionByAgent = new Map(sessions.map((s) => [s.agentId, s]));

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

  // Activity (D), DESCRIPTION layer: per-agent live activity (fresh, non-terminal
  // latest event). This no longer *decides* `working` — it only supplies the
  // "Using <tool> · 12s" detail when the agent is working. The boolean comes
  // from the per-chat runtime state below (with a legacy fallback).
  const activityByAgent = await deriveAgentActivity(db, chatId);

  const now = Date.now();
  return agentIds.map((agentId) => {
    const sess = sessionByAgent.get(agentId);
    const state = sess?.state;
    const p = presenceById.get(agentId);
    const activity = activityByAgent.get(agentId) ?? null;
    const engagement: AgentEngagement = state === "active" ? "active" : state === "suspended" ? "suspended" : "none";

    // D-axis `working`: authoritative per-chat runtime when the client reports
    // it (`runtime_state_at` non-null), else the legacy event proxy. Gated on an
    // active session so a stale `runtime_state` left on a suspended row (the
    // suspend path doesn't reset it) cannot read as working.
    const working =
      sess?.runtimeStateAt != null
        ? engagement === "active" &&
          sess.runtimeState === "working" &&
          now - sess.runtimeStateAt.getTime() <= RUNTIME_STALE_MS
        : // Legacy event-proxy fallback (old client, never reported per-chat
          // runtime). Gate on `active` too — lockstep with the authoritative
          // path and with `deriveWorkingAgents` — so a suspended session with a
          // still-fresh event reads as Paused, not Working.
          engagement === "active" && activity != null;

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
      working,
      engagement,
      // The activity is a descriptor of in-flight work — carry it only while
      // working, matching the schema's "null when not working" contract.
      activity: working ? activity : null,
    });
  });
}

/**
 * Per-agent live activity in `chatId`: the latest `session_events` row per
 * pair, mapped through `toLiveActivity` (so terminal kinds → absent) and
 * dropped when older than the stale threshold. Per-pair LATERAL seek on the
 * unique `(agent_id, chat_id, seq)` index — the same shape as
 * `deriveLiveActivity`, resolved per agent rather than collapsed per chat.
 */
async function deriveAgentActivity(db: Database, chatId: string): Promise<Map<string, LiveActivity>> {
  const rows = (await db.execute(sql`
    SELECT acs.agent_id AS agent_id, e.kind AS kind, e.payload AS payload, e.created_at AS created_at
      FROM agent_chat_sessions acs
      CROSS JOIN LATERAL (
        SELECT kind, payload, created_at, seq
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
         ORDER BY se.seq DESC
         LIMIT 1
      ) e
     WHERE acs.chat_id = ${chatId}
       AND acs.state <> 'evicted'
  `)) as unknown as Array<{ agent_id: string; kind: string; payload: unknown; created_at: Date | string }>;
  const now = Date.now();
  const out = new Map<string, LiveActivity>();
  for (const r of rows) {
    if (now - new Date(r.created_at).getTime() > LIVE_ACTIVITY_STALE_MS) continue;
    const activity = toLiveActivity({
      agent_id: r.agent_id,
      chat_id: chatId,
      kind: r.kind,
      payload: r.payload,
      created_at: r.created_at,
    });
    if (activity) out.set(r.agent_id, activity);
  }
  return out;
}
