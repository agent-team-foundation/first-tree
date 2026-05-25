import {
  type AgentChatStatus,
  type AgentEngagement,
  ASSISTANT_TEXT_PREVIEW_MAX,
  type AssistantTextEventPayload,
  buildAgentChatStatus,
  LIVE_ACTIVITY_STALE_MS,
  type LiveActivity,
  type ToolCallEventPayload,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { pendingQuestions } from "../db/schema/pending-questions.js";

/**
 * Single source of truth for per-(agent,chat) composite status.
 *
 * `resolveAgentChatStatuses` is the ONE producer behind every chat surface:
 *   - `GET /chats/:chatId/agent-status` (this file's `getChatAgentStatuses`),
 *   - the chat-list `failedAgentIds` / `liveActivity` / `pendingQuestionAgentIds`
 *     projections in `services/me-chat.ts`.
 *
 * It folds the four orthogonal axes per agent and reduces them via the shared
 * `buildAgentChatStatus` (so `main` is always derived, never hand-set):
 *   - reachability (A): the agent has a bound client (`agent_presence.client_id`)
 *   - engagement   (C): `agent_chat_sessions.state` for this pair
 *   - activity     (D): a fresh, non-terminal latest `session_events` row
 *   - attention       : a pending AskUserQuestion (`pending_questions`)
 *     OR a failure (session `errored` OR runtime `error`)
 *
 * The `errored` predicate lives here ONCE (it used to be duplicated as a TS
 * predicate in this file AND a Drizzle clause in `me-chat.ts:deriveFailedAgents`,
 * "kept in lockstep by test"). The live-activity LATERAL seek also lives here
 * once (it used to be implemented twice — `deriveAgentActivity` here and
 * `deriveLiveActivity` in me-chat.ts).
 */

// ---------------------------------------------------------------------------
// Live-activity preview helpers (moved here from me-chat.ts so the producer
// owns the whole derivation; a one-directional import keeps me-chat.ts → this
// module acyclic).
// ---------------------------------------------------------------------------

/** Max length of the tool-arg preview surfaced in `LiveActivity.detail`. */
const ARG_PREVIEW_MAX = 32;

/**
 * Best-effort short preview of a tool call's args, for the compose status bar's
 * `Using Bash · npm test` detail. Picks a meaningful field for common tools
 * (command / path / query / …), else stringifies; whitespace-collapsed and
 * truncated to {@link ARG_PREVIEW_MAX}. Returns undefined when there's nothing
 * useful to show. Exported for unit testing.
 */
export function previewToolArgs(args: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof args === "string") {
    raw = args;
  } else if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    // Only fields that hold an *argument value* the user would recognise. NOT
    // `description` (that's a tool's self-description, not what it's running);
    // the JSON.stringify fallback below covers tools with no recognised field.
    const pick = o.command ?? o.cmd ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url;
    if (typeof pick === "string") raw = pick;
    else if (Object.keys(o).length > 0) raw = JSON.stringify(o); // empty {} → no detail
  }
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > ARG_PREVIEW_MAX ? `${oneLine.slice(0, ARG_PREVIEW_MAX - 1)}…` : oneLine;
}

/**
 * One-line preview of an assistant text block for the compose status bar's
 * liveness detail. Whitespace-collapsed and hard-capped to
 * {@link ASSISTANT_TEXT_PREVIEW_MAX} — no trailing "…" is added, since the
 * rail's CSS owns the visible ellipsis. Returns undefined for an empty /
 * whitespace-only block so the status bar falls back to the static "Writing".
 * Exported for unit testing.
 */
export function previewAssistantText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.slice(0, ASSISTANT_TEXT_PREVIEW_MAX);
}

/**
 * Translate a `session_events` row into a `LiveActivity`, or null when the
 * kind is terminal (`turn_end` / `error`) or unrecognised. Pure & exported
 * for unit testing.
 */
export function toLiveActivity(row: {
  agent_id: string;
  chat_id: string;
  kind: string;
  payload: unknown;
  created_at: Date | string;
}): LiveActivity | null {
  const startedAt = new Date(row.created_at).toISOString();
  // Expiry the client uses to self-clear a lingering chip (matches the read-time
  // stale cutoff this module already applies in `deriveActivities`).
  const staleAt = new Date(new Date(row.created_at).getTime() + LIVE_ACTIVITY_STALE_MS).toISOString();
  switch (row.kind) {
    case "tool_call": {
      const payload = (row.payload ?? {}) as Partial<ToolCallEventPayload>;
      const label = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : "Tool";
      const detail = previewToolArgs(payload.args);
      return { agentId: row.agent_id, kind: "tool_call", label, startedAt, staleAt, ...(detail ? { detail } : {}) };
    }
    case "thinking":
      return { agentId: row.agent_id, kind: "thinking", label: "Thinking", startedAt, staleAt };
    case "assistant_text": {
      const payload = (row.payload ?? {}) as Partial<AssistantTextEventPayload>;
      const detail = previewAssistantText(payload.text);
      return {
        agentId: row.agent_id,
        kind: "assistant_text",
        label: "Writing",
        startedAt,
        staleAt,
        ...(detail ? { detail } : {}),
      };
    }
    default:
      // turn_end / error / unknown → no live indicator
      return null;
  }
}

/**
 * Sticky narration for a working agent's live activity. Surfaces the current
 * turn's latest `assistant_text` (what the agent is *saying*) on `turnText` so
 * the compose status bar keeps showing the narration even after a `tool_call`
 * arrives — without it the activity is the single newest event, and a tool call
 * fired right after a sentence buries the prose. Leaves `turnText` absent (base
 * activity unchanged) when the turn has produced no prose yet. Base `kind` /
 * `label` / `detail` are preserved, so the sidebar AgentRow and chat-list chip
 * keep reading `Using <tool>`. Pure & exported for unit testing.
 */
export function withTurnNarration(base: LiveActivity | null, narrationText: unknown): LiveActivity | null {
  if (!base) return null;
  const narration = previewAssistantText(narrationText);
  return narration ? { ...base, turnText: narration } : base;
}

/**
 * Per-chat set of agent ids with a PENDING question (`pending_questions`
 * status = 'pending'), grouped chatId → agentId[]. Chats with no pending
 * question are absent from the map (caller treats absence as []). One
 * indexed read via `idx_pending_questions_chat_status`. Not membership- or
 * type-filtered (humans never write pending questions, so the set is
 * effectively non-human).
 */
export async function derivePendingQuestions(db: Database, chatIds: string[]): Promise<Map<string, string[]>> {
  if (chatIds.length === 0) return new Map();
  const rows = await db
    .select({ chatId: pendingQuestions.chatId, agentId: pendingQuestions.agentId })
    .from(pendingQuestions)
    .where(and(inArray(pendingQuestions.chatId, chatIds), eq(pendingQuestions.status, "pending")));
  // Dedupe per chat: one agent may have several pending questions in the same
  // chat, but the field is "agents with a pending question" (a set).
  const sets = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = sets.get(row.chatId);
    if (set) set.add(row.agentId);
    else sets.set(row.chatId, new Set([row.agentId]));
  }
  const out = new Map<string, string[]>();
  for (const [chatId, set] of sets) out.set(chatId, [...set]);
  return out;
}

// ---------------------------------------------------------------------------
// Activity derivation (merged LATERAL — replaces the former twin
// `deriveLiveActivity` (me-chat.ts) and `deriveAgentActivity` (here)).
// ---------------------------------------------------------------------------

/**
 * Per-(agent,chat) live activity for `chatIds`: the latest `session_events`
 * row per pair, mapped through `toLiveActivity` (terminal kinds → absent) and
 * dropped when older than the stale threshold. Per-pair LATERAL seek on the
 * unique `(agent_id, chat_id, seq)` index — a single B-tree descent per pair,
 * independent of `session_events` table size.
 *
 * When `withTurnText`, a second `LEFT JOIN LATERAL` seeks the current turn's
 * latest `assistant_text` (`seq` past the last `turn_end`); `withTurnNarration`
 * rides it along as `turnText` so the compose status bar can show the running
 * narration even while a tool runs. Only the per-agent `/agent-status` path
 * pays for the extra seek; the chat-list passes `withTurnText: false`.
 */
async function deriveActivities(
  db: Database,
  chatIds: string[],
  opts?: { withTurnText?: boolean },
): Promise<Map<string, Map<string, LiveActivity>>> {
  const out = new Map<string, Map<string, LiveActivity>>();
  if (chatIds.length === 0) return out;

  const withTurn = opts?.withTurnText === true;
  // `IN (${...})` rather than `= ANY($1::text[])`: postgres-js binds string[]
  // as a flat string when the driver type hint resolves to text[], which PG
  // rejects. Inlining each value sidesteps the binding mismatch.
  const chatIdInClause = sql.join(
    chatIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const turnTextSelect = withTurn ? sql`, t.text AS turn_text` : sql`, NULL::text AS turn_text`;
  const turnTextJoin = withTurn
    ? sql`
      LEFT JOIN LATERAL (
        -- Generous raw prefix cap: bounds the bytes pulled from PG while
        -- leaving ample margin for previewAssistantText (collapses whitespace,
        -- then caps at ASSISTANT_TEXT_PREVIEW_MAX = 120). Wider than 120 so
        -- pathological leading whitespace cannot starve the final value.
        SELECT LEFT(se.payload->>'text', 500) AS text
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
      ) t ON TRUE`
    : sql``;

  const rawRows = (await db.execute(sql`
    SELECT acs.agent_id        AS agent_id,
           acs.chat_id         AS chat_id,
           e.kind              AS kind,
           e.payload           AS payload,
           e.created_at        AS created_at
           ${turnTextSelect}
      FROM agent_chat_sessions acs
      CROSS JOIN LATERAL (
        SELECT kind, payload, created_at, seq
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
         ORDER BY se.seq DESC
         LIMIT 1
      ) e
      ${turnTextJoin}
     WHERE acs.chat_id IN (${chatIdInClause})
       AND acs.state <> 'evicted'
  `)) as unknown as Array<{
    agent_id: string;
    chat_id: string;
    kind: string;
    payload: unknown;
    created_at: Date | string;
    turn_text: string | null;
  }>;

  const now = Date.now();
  for (const r of rawRows) {
    if (now - new Date(r.created_at).getTime() > LIVE_ACTIVITY_STALE_MS) continue;
    const base = toLiveActivity({
      agent_id: r.agent_id,
      chat_id: r.chat_id,
      kind: r.kind,
      payload: r.payload,
      created_at: r.created_at,
    });
    const activity = withTurnNarration(base, r.turn_text);
    if (!activity) continue;
    let perAgent = out.get(r.chat_id);
    if (!perAgent) {
      perAgent = new Map();
      out.set(r.chat_id, perAgent);
    }
    perAgent.set(r.agent_id, activity);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

const ROW_SEP = " ";
const pairKey = (chatId: string, agentId: string) => `${chatId}${ROW_SEP}${agentId}`;

/**
 * Composite per-(agent,chat) status for every relevant non-human agent across
 * `chatIds`, grouped chatId → AgentChatStatus[].
 *
 * Agent set per chat = the UNION (humans excluded everywhere):
 *   - non-human speakers (the /agent-status set; every speaker resolves so a
 *     reachable-but-idle speaker still reads `ready` and an unbound one
 *     `offline`), and
 *   - non-human agents with a PENDING question (so the chat-list
 *     `pendingQuestionAgentIds`, which is NOT speaker-filtered, is reproduced
 *     from this one call even for a pending agent that has since left).
 * Non-speaker session-holders are intentionally NOT a union source: after the
 * chat-list live-dot narrowed to speakers they surface on no list/panel.
 *
 * Callers project per-surface (each already knows its speaker set):
 *   - /agent-status → filter to non-human speakers (getChatAgentStatuses).
 *   - me/chats failed/live-dot → speaker-filtered; pending → not filtered.
 */
export async function resolveAgentChatStatuses(
  db: Database,
  chatIds: string[],
  opts?: { withTurnText?: boolean },
): Promise<Map<string, AgentChatStatus[]>> {
  const out = new Map<string, AgentChatStatus[]>();
  if (chatIds.length === 0) return out;

  // -- Union source 1: non-human speakers per chat.
  const speakerRows = await db
    .select({ chatId: chatMembership.chatId, agentId: chatMembership.agentId })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(
      and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.accessMode, "speaker"), ne(agents.type, "human")),
    );

  // -- Union source 2: pending-question agents per chat (raw; may include a
  // non-speaker who left while a question was pending). Filter to non-human.
  const pendingByChat = await derivePendingQuestions(db, chatIds);
  const pendingAllIds = [...new Set([...pendingByChat.values()].flat())];
  const nonHumanPending =
    pendingAllIds.length > 0
      ? new Set(
          (
            await db
              .select({ uuid: agents.uuid })
              .from(agents)
              .where(and(inArray(agents.uuid, pendingAllIds), ne(agents.type, "human")))
          ).map((r) => r.uuid),
        )
      : new Set<string>();

  // Build the union + a per-chat pending-set for the needsYou axis.
  const unionByChat = new Map<string, Set<string>>();
  const pendingSetByChat = new Map<string, Set<string>>();
  const addUnion = (chatId: string, agentId: string) => {
    let s = unionByChat.get(chatId);
    if (!s) {
      s = new Set();
      unionByChat.set(chatId, s);
    }
    s.add(agentId);
  };
  for (const r of speakerRows) addUnion(r.chatId, r.agentId);
  for (const [chatId, ids] of pendingByChat) {
    const set = new Set<string>();
    for (const id of ids) {
      if (!nonHumanPending.has(id)) continue;
      addUnion(chatId, id);
      set.add(id);
    }
    if (set.size > 0) pendingSetByChat.set(chatId, set);
  }
  if (unionByChat.size === 0) return out;

  const allAgentIds = [...new Set([...unionByChat.values()].flatMap((s) => [...s]))];

  // -- Engagement (C): per-(agent,chat) session state, for the union pairs.
  const sessionRows = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
    })
    .from(agentChatSessions)
    .where(and(inArray(agentChatSessions.chatId, chatIds), inArray(agentChatSessions.agentId, allAgentIds)));
  const sessionState = new Map(sessionRows.map((s) => [pairKey(s.chatId, s.agentId), s.state]));

  // -- Reachability (A) + runtime error: per-agent (not per-chat) presence.
  const presenceRows = await db
    .select({
      agentId: agentPresence.agentId,
      clientId: agentPresence.clientId,
      runtimeState: agentPresence.runtimeState,
    })
    .from(agentPresence)
    .where(inArray(agentPresence.agentId, allAgentIds));
  const presenceById = new Map(presenceRows.map((p) => [p.agentId, p]));

  // -- Activity (D): per-(agent,chat) live activity (+ turnText when asked).
  const activityByChat = await deriveActivities(db, chatIds, opts);

  for (const [chatId, agentSet] of unionByChat) {
    const pendingSet = pendingSetByChat.get(chatId);
    const perAgentActivity = activityByChat.get(chatId);
    const arr: AgentChatStatus[] = [];
    for (const agentId of agentSet) {
      const state = sessionState.get(pairKey(chatId, agentId));
      const p = presenceById.get(agentId);
      const activity = perAgentActivity?.get(agentId) ?? null;
      const engagement: AgentEngagement = state === "active" ? "active" : state === "suspended" ? "suspended" : "none";
      arr.push(
        buildAgentChatStatus({
          agentId,
          reachable: p?.clientId != null,
          // failed = session errored OR runtime error (the reachable gate is
          // applied by `deriveMainStatus`: unreachable → offline, not failed).
          errored: state === "errored" || p?.runtimeState === "error",
          needsYou: pendingSet?.has(agentId) ?? false,
          working: activity != null,
          engagement,
          activity,
        }),
      );
    }
    out.set(chatId, arr);
  }
  return out;
}

/**
 * Composite status for every non-human speaker in a chat — the
 * server-authoritative aggregation behind `GET /chats/:chatId/agent-status`.
 * Thin projection over `resolveAgentChatStatuses`, filtered to the speaker set
 * (the union may also contain a pending non-speaker, which this surface omits).
 */
export async function getChatAgentStatuses(db: Database, chatId: string): Promise<AgentChatStatus[]> {
  const speakerRows = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker"), ne(agents.type, "human")));
  const speakerIds = new Set(speakerRows.map((r) => r.agentId));
  if (speakerIds.size === 0) return [];

  const byChat = await resolveAgentChatStatuses(db, [chatId], { withTurnText: true });
  return (byChat.get(chatId) ?? []).filter((s) => speakerIds.has(s.agentId));
}
