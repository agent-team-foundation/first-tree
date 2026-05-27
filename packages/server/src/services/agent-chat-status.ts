import {
  type AgentChatStatus,
  type AgentEngagement,
  ASSISTANT_TEXT_PREVIEW_MAX,
  type AssistantTextEventPayload,
  buildAgentChatStatus,
  LIVE_ACTIVITY_STALE_MS,
  type LiveActivity,
  RUNTIME_STALE_MS,
  type RuntimeState,
  type ToolCallEventPayload,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { attentions } from "../db/schema/attentions.js";
import { chatMembership } from "../db/schema/chat-membership.js";

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
 * For each chat in `chatIds`, returns the set of agent uuids that have at
 * least one **open** attention (`state='open' AND requires_response=true`)
 * authored by them. Chats with none are absent from the map (caller treats
 * absence as []).
 *
 * Repointed from the M0 `pending_questions` table to the NHA `attentions`
 * primitive per proposal §6 ("M1 末将该信号通道 repoint 到 attentions 表").
 * The function name stays for minimum churn — call sites already say
 * "pending question" but the semantics are now "open ask NHA". The
 * downstream `needsYou` axis flips on any of these, which is the same red-
 * dot signal humans saw before the cleanup.
 *
 * One indexed read via `idx_attentions_chat_open` (covers chat_id + state).
 * Notifications (`requires_response=false`) are inserted in `state='closed'`
 * so they never match this query — the queue stays clean per proposal §4.7.
 */
export async function derivePendingQuestions(db: Database, chatIds: string[]): Promise<Map<string, string[]>> {
  if (chatIds.length === 0) return new Map();
  const rows = await db
    .select({ chatId: attentions.originChatId, agentId: attentions.originAgentId })
    .from(attentions)
    .where(
      and(
        inArray(attentions.originChatId, chatIds),
        eq(attentions.state, "open"),
        eq(attentions.requiresResponse, true),
      ),
    );
  // Dedupe per chat: one agent may have several open attentions in the same
  // chat (a corner case; proposal §5.1 expects 0-or-1 per (agent, chat)).
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

  // -- Engagement (C) + D-axis runtime: per-(agent,chat) session row.
  // `runtime_state` / `runtime_state_at` feed `computeWorking` / `computeErrored`
  // — the per-chat authoritative source replacing the legacy event-proxy
  // (which only knew "fresh event = working" and missed codex no-events).
  const sessionRows = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      runtimeState: agentChatSessions.runtimeState,
      runtimeStateAt: agentChatSessions.runtimeStateAt,
    })
    .from(agentChatSessions)
    .where(and(inArray(agentChatSessions.chatId, chatIds), inArray(agentChatSessions.agentId, allAgentIds)));
  const sessionByPair = new Map(sessionRows.map((s) => [pairKey(s.chatId, s.agentId), s]));

  // -- Reachability (A) + legacy presence runtime (for the old-client
  //    fallback path only — see `computeWorking` / `computeErrored`).
  //    For agents whose client has already reported per-chat runtime at
  //    least once (`runtime_state_at IS NOT NULL`), `presence.runtimeState`
  //    is NOT consumed by composite working / errored — the per-chat path
  //    is authoritative and the reverse-#366 leak stays closed. For agents
  //    that have never reported (NULL stamp = old client in the upgrade
  //    window) we fall back to the legacy `session_events` freshness proxy
  //    for working AND the legacy `presence.runtimeState === 'error'`
  //    OR-fold for errored, for one release cycle. Matches the approved
  //    spec (proposals/hub-agent-status-working-freshness.20260525.md
  //    §6.1 §10).
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
  //    Pure description: 60s drop here means "5-min-old tool_call is not the
  //    current activity description", not "agent is not working" (which is
  //    decided by `computeWorking` above).
  const activityByChat = await deriveActivities(db, chatIds, opts);

  const now = Date.now();
  for (const [chatId, agentSet] of unionByChat) {
    const pendingSet = pendingSetByChat.get(chatId);
    const perAgentActivity = activityByChat.get(chatId);
    const arr: AgentChatStatus[] = [];
    for (const agentId of agentSet) {
      const sess = sessionByPair.get(pairKey(chatId, agentId));
      const state = sess?.state;
      const p = presenceById.get(agentId);
      const activity = perAgentActivity?.get(agentId) ?? null;
      const engagement: AgentEngagement = state === "active" ? "active" : state === "suspended" ? "suspended" : "none";
      const working = computeWorking(sess, activity, now);
      arr.push(
        buildAgentChatStatus({
          agentId,
          reachable: p?.clientId != null,
          errored: computeErrored(sess, p?.runtimeState ?? null, now),
          needsYou: pendingSet?.has(agentId) ?? false,
          working,
          engagement,
          // The activity is a descriptor of in-flight work — carry it only
          // while working, matching the schema's "null when not working"
          // contract. Codex no-events case (new-client authoritative path):
          // working=true & activity=null ⇒ UI shows a generic "Working"
          // with no tool detail.
          //
          // Transient inversion to note for posterity (non-blocking; matches
          // the spec's "activity is description-only when working"): a
          // `session:event` recompute that races marginally ahead of its
          // corresponding `session:runtime working` (different paths — events
          // aren't in chainSessionOp) briefly emits activity=null; the next
          // runtime frame self-heals.
          activity: working ? activity : null,
        }),
      );
    }
    out.set(chatId, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// D-axis projection helpers — pure, exported for unit tests.
//
// The composite working / errored axes are fed by the per-chat
// `agent_chat_sessions.runtime_state` (+ `runtime_state_at` freshness) for
// NEW clients (any client that has reported `session:runtime` at least once
// for this pair — `runtime_state_at IS NOT NULL`). For OLD clients in the
// upgrade window (NULL stamp, never reported) we fall back to the legacy
// signals for one release cycle:
//   - working: the latest non-terminal `session_events` row within
//     LIVE_ACTIVITY_STALE_MS (the pre-PR proxy).
//   - errored: the agent-global `presence.runtime_state === 'error'`
//     OR-fold (the pre-PR behaviour — yes, this still has the reverse-#366
//     cross-chat leak for old clients, but that's the existing prod
//     behaviour, not a new regression — and it self-closes the moment the
//     client upgrades and starts reporting per-chat).
// `state === 'errored'` (C-axis lifecycle) always contributes to errored
// independently of the D-axis on both paths.
//
// Spec reference: proposals/hub-agent-status-working-freshness.20260525.md
// §6.1 §10 ("保留旧 client 兼容兜底一个发布周期").
// ---------------------------------------------------------------------------

// `runtimeState` is `text` in the DB (no enum constraint at the TS level), so
// it surfaces as plain `string` from drizzle. Helpers compare to literal
// values — a row carrying an unrecognised value falls into the fail-closed
// default (not working, not errored from D-axis), which is the right
// degradation if a buggy producer ever wrote a junk state.
type RuntimeSessionRow =
  | {
      state: string;
      runtimeState: string;
      runtimeStateAt: Date | null;
    }
  | undefined;

/**
 * True iff the new-client authoritative path applies — session is active and
 * the client has reported per-chat runtime within the freshness window.
 * Returns false for old clients (NULL stamp), stale stamps, and non-active
 * sessions; the caller should fall back to legacy signals on false-with-
 * NULL-stamp and treat false-with-stale-stamp as fail-closed.
 */
export function isRuntimeFresh(session: RuntimeSessionRow, now: number): boolean {
  if (!session || session.state !== "active") return false;
  if (session.runtimeStateAt == null) return false;
  return now - session.runtimeStateAt.getTime() <= RUNTIME_STALE_MS;
}

/**
 * Authoritative path: active session + fresh `runtime_state === 'working'`.
 * Old-client fallback (NULL stamp on an active session): the presence of
 * any fresh non-terminal `session_events` row (= `activity != null`), which
 * is exactly what the pre-PR producer used. Old-client fallback for a
 * stale stamp is intentionally NOT applied — once a client has reported
 * per-chat runtime at least once we stay on the new path and let the
 * freshness window decide (so `RUNTIME_STALE_MS` cannot regress for an
 * upgraded client just because of a transient disconnect).
 */
export function computeWorking(session: RuntimeSessionRow, activity: LiveActivity | null, now: number): boolean {
  if (!session || session.state !== "active") return false;
  if (session.runtimeStateAt == null) {
    // Old client (one release cycle): legacy event-proxy fallback.
    return activity != null;
  }
  return isRuntimeFresh(session, now) && session.runtimeState === ("working" satisfies RuntimeState);
}

/**
 * Authoritative path: C-axis `state === 'errored'` always contributes; the
 * D-axis 'error' axis contributes when active + fresh. Old-client fallback
 * (NULL stamp on an active session): legacy `presence.runtime_state ===
 * 'error'` OR-fold, which is pre-PR behaviour (still has the reverse-#366
 * cross-chat leak for old clients; that's the existing prod regression
 * envelope and self-closes when the client upgrades). Spec §6.1 §10.
 */
export function computeErrored(session: RuntimeSessionRow, presenceRuntimeState: string | null, now: number): boolean {
  if (session?.state === "errored") return true;
  if (!session || session.state !== "active") return false;
  if (session.runtimeStateAt == null) {
    // Old client (one release cycle): legacy agent-global error fallback.
    return presenceRuntimeState === "error";
  }
  return isRuntimeFresh(session, now) && session.runtimeState === ("error" satisfies RuntimeState);
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
