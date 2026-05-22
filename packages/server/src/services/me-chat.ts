/**
 * Member-facing chat service backing `/me/chats*` endpoints (chat-first
 * workspace).
 *
 * Responsibilities:
 *   - Cursor-paginated conversation list (single-stream JOIN over the
 *     unified `chat_membership` + `chat_user_state` tables).
 *   - Create a new chat (no dedupe, runs `recomputeChatWatchers` after).
 *   - Add participants (idempotent, UPSERT into `chat_membership`,
 *     runs `recomputeChatWatchers` after).
 *   - Mark-read (UPSERT into `chat_user_state`).
 *   - Join → watcher to speaker (delegates to `watcher.ts`).
 *   - Leave → speaker to watcher or detach (delegates to `watcher.ts`).
 *
 * See proposals/chat-data-model-restructure.20260512.md §8 (schema)
 * and §11.1 (per-route mapping).
 */

import { randomUUID } from "node:crypto";
import {
  type AddMeChatParticipants,
  AGENT_VISIBILITY,
  CHAT_ENGAGEMENT_STATUSES,
  type ChatEngagementStatus,
  type ChatEngagementView,
  type ChatSource,
  type CreateMeChat,
  GITHUB_ENTITY_TYPES,
  type GithubEntityType,
  LIVE_ACTIVITY_STALE_MS,
  type ListMeChatSourceCountsQuery,
  type ListMeChatsQuery,
  type ListMeChatsResponse,
  type LiveActivity,
  type MeChatLeaveResponse,
  type MeChatReadResponse,
  type MeChatRow,
  type MeChatSourceCounts,
  type MeChatUnreadResponse,
  type ToolCallEventPayload,
} from "@first-tree/shared";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { agentAvatarImageUrl } from "./agent.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { addChatParticipants } from "./participant-mode.js";
import { extractSummary } from "./session.js";
import {
  ensureCanJoin,
  joinAsParticipant,
  leaveAsParticipant,
  recomputeChatWatchers,
  resolveChatMembership,
} from "./watcher.js";

// ---------------------------------------------------------------------------
// Cursor encoding
// ---------------------------------------------------------------------------
//
// Cursor is `<lastMessageAtIso>|<chatId>`. Encoded base64url so it survives
// query strings without escaping. Sort ordering is
// `(last_message_at DESC NULLS LAST, chat_id DESC)`.

export function encodeCursor(lastMessageAt: Date | null, chatId: string): string {
  const payload = `${lastMessageAt ? lastMessageAt.toISOString() : ""}|${chatId}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { lastMessageAt: Date | null; chatId: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep < 0) return null;
    const tsPart = decoded.slice(0, sep);
    const chatId = decoded.slice(sep + 1);
    if (!chatId) return null;
    const lastMessageAt = tsPart.length > 0 ? new Date(tsPart) : null;
    if (lastMessageAt && Number.isNaN(lastMessageAt.getTime())) return null;
    return { lastMessageAt, chatId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------
//
// `engagement_status` lives on `chat_user_state` alongside `last_read_at` and
// `unread_mention_count` — all three are per-(chat, user) private state. Rows
// are lazy-materialised: a missing row is interpreted as `'active'` (default
// engagement, no unread, never marked read). All reads use
// `COALESCE(engagement_status, 'active')` so callers see a defined value
// regardless of whether the row exists.

const { ACTIVE, ARCHIVED, DELETED } = CHAT_ENGAGEMENT_STATUSES;

/**
 * SQL predicate for each engagement view tab. `deleted` is never a valid view
 * value — deleted rows are reachable only through `GET /chats/:chatId` + the
 * Restore banner on the chat detail page.
 */
const ENGAGEMENT_VIEW_PREDICATE: Record<ChatEngagementView, SQL> = {
  active: sql`COALESCE(cus.engagement_status, ${ACTIVE}) = ${ACTIVE}`,
  archived: sql`COALESCE(cus.engagement_status, ${ACTIVE}) = ${ARCHIVED}`,
  all: sql`COALESCE(cus.engagement_status, ${ACTIVE}) IN (${ACTIVE}, ${ARCHIVED})`,
};

/**
 * Write the caller's engagement state for this chat. UPSERT into
 * `chat_user_state` — the row may not yet exist (the user might not have
 * marked-read or been @-mentioned), so an INSERT with the engagement value
 * is the first write; subsequent transitions are UPDATEs.
 *
 * Idempotent. Mirrors the UPSERT shape used by `markMeChatRead`.
 */
export async function setChatEngagement(
  db: Database,
  chatId: string,
  agentId: string,
  status: ChatEngagementStatus,
): Promise<void> {
  await db
    .insert(chatUserState)
    .values({
      chatId,
      agentId,
      unreadMentionCount: 0,
      engagementStatus: status,
    })
    .onConflictDoUpdate({
      target: [chatUserState.chatId, chatUserState.agentId],
      set: { engagementStatus: status },
    });
}

/**
 * Read the caller's engagement state. Returns `'active'` when no
 * `chat_user_state` row exists yet (lazy-materialised; matches the SQL
 * `COALESCE(..., 'active')` used elsewhere).
 */
export async function getCallerEngagement(
  db: Database,
  chatId: string,
  agentId: string,
): Promise<ChatEngagementStatus> {
  const [row] = await db
    .select({ engagementStatus: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, agentId)))
    .limit(1);
  return (row?.engagementStatus as ChatEngagementStatus) ?? ACTIVE;
}

// ---------------------------------------------------------------------------
// Origin projection
// ---------------------------------------------------------------------------
//
// The conversation-list filter popover splits chats by coarse-grained
// origin — Manual / GitHub / Feishu (one per integration, not one per
// entity type within an integration). The per-entity GitHub granularity
// (PR / Issue / Discussion / Commit) is preserved on the row via the
// separate `entity_type` SELECT so the rail's leading icon can still
// render the right glyph.
//
//   - `sourceFilterSql(source)` — WHERE predicate for `listMeChats`.
//   - `chatSourceSqlExpression` — CASE projected into the response row
//     and shared with `listMeChatSourceCounts` for the aggregate GROUP BY.
//
// Invariant: every row that `chatSourceSqlExpression` labels `github`
// MUST also match `sourceFilterSql("github")`, and vice versa. The
// classifier collapses any GitHub metadata into `github` regardless of
// the inner `entityType`, so a malformed row like
// `{source:"github", entityType:"some-new-thing"}` still lands in the
// `github` bucket — by design, since the popover-level filter doesn't
// care about the entity sub-type.

const KNOWN_NON_MANUAL_PREDICATE = sql`(
     c.metadata->>'source' = 'github'
  OR c.metadata->>'source' = 'feishu'
)`;

const chatSourceSqlExpression = sql`CASE
    WHEN c.metadata->>'source' = 'github' THEN 'github'
    WHEN c.metadata->>'source' = 'feishu' THEN 'feishu'
    ELSE 'manual'
  END`;

/**
 * Set membership check for `chats.metadata->>'entityType'`. Used to
 * narrow the raw text to the typed `GithubEntityType` literal union
 * before handing it back to the web client — anything outside the
 * known set decays to `null` so the row schema stays well-typed even
 * if the DB picks up an unfamiliar value across version skew.
 */
const KNOWN_GITHUB_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(GITHUB_ENTITY_TYPES);
function isKnownGithubEntityType(value: string): value is GithubEntityType {
  return KNOWN_GITHUB_ENTITY_TYPE_SET.has(value);
}

function sourceFilterSql(source: ChatSource): SQL {
  switch (source) {
    case "manual":
      // Defined as the negation of every known-non-manual case so we
      // stay in lock-step with `chatSourceSqlExpression`'s ELSE arm.
      // `IS NOT TRUE` (not `NOT (...)`) because `metadata->>'source'`
      // is NULL for the `{}` / NULL metadata cases — `NULL = 'github'`
      // is NULL, and `NOT NULL` is still NULL in WHERE, which Postgres
      // treats as FALSE and would silently drop every manual chat
      // from the list.
      return sql`(${KNOWN_NON_MANUAL_PREDICATE}) IS NOT TRUE`;
    case "github":
      return sql`(c.metadata->>'source' = 'github')`;
    case "feishu":
      return sql`(c.metadata->>'source' = 'feishu')`;
  }
}

/**
 * WHERE predicate for the multi-select origin filter (Phase B). Returns
 * a disjunction over each requested origin's `sourceFilterSql` arm, so
 * `["manual", "github_pull_request"]` becomes
 * `(manual_predicate OR pr_predicate)`. Empty / undefined input returns
 * `TRUE` so callers can blanket it onto the WHERE clause without a
 * conditional. Deduplicates input via `Set` defensively — a user
 * selecting the same chip twice shouldn't expand into duplicate OR arms.
 */
function originsFilterSql(origins: ReadonlyArray<ChatSource>): SQL {
  const unique = Array.from(new Set(origins));
  if (unique.length === 0) return sql`TRUE`;
  if (unique.length === 1) {
    const only = unique[0];
    if (only === undefined) return sql`TRUE`;
    return sourceFilterSql(only);
  }
  return sql`(${sql.join(
    unique.map((o) => sourceFilterSql(o)),
    sql.raw(" OR "),
  )})`;
}

/**
 * WHERE predicate for the participants filter (Phase B). Returns chats
 * where any of the named speaker agents is in the membership — OR
 * semantics, matching the way users typically select multiple
 * participant chips ("show chats with @a or @b" rather than the
 * stricter "with both"). Empty / undefined input returns `TRUE`.
 *
 * Implemented as a `chat_id IN (subquery)` rather than an extra JOIN
 * so the result row is still 1:1 with the outer chat and the existing
 * cursor pagination is unaffected.
 */
function participantsFilterSql(agentIds: ReadonlyArray<string>): SQL {
  const unique = Array.from(new Set(agentIds.filter((id) => id.length > 0)));
  if (unique.length === 0) return sql`TRUE`;
  return sql`c.id IN (
    SELECT chat_id FROM chat_membership
    WHERE access_mode = 'speaker'
      AND agent_id IN (${sql.join(
        unique.map((id) => sql`${id}`),
        sql.raw(", "),
      )})
  )`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * GET /me/chats — cursor-paginated conversation list.
 *
 * SQL strategy:
 *   - Single-stream query: `chats JOIN chat_membership LEFT JOIN
 *     chat_user_state`. The membership row carries access_mode
 *     (speaker → "participant" / watcher → "watching"); the user
 *     state row supplies the unread counter (COALESCE → 0 when
 *     row is missing).
 *   - Filter `parent_chat_id IS NULL` defensively. Hub has no sub-chat
 *     product layer (see first-tree-context PR #281); the column is
 *     decision-inert scaffolding, so any historical non-null row stays
 *     hidden from the conversation list.
 *   - Filter `c.organization_id = ?` to defend against historical
 *     cross-org pollution rows that may still reference the caller
 *     (see fix/cross-org-direct-chat-pollution).
 *   - Sort `(last_message_at DESC NULLS LAST, chat_id DESC)`.
 *   - Cursor narrows the result to rows STRICTLY before the cursor.
 *   - Followed by a participants-list lookup for the page only.
 */
export async function listMeChats(
  db: Database,
  humanAgentId: string,
  organizationId: string,
  query: ListMeChatsQuery,
): Promise<ListMeChatsResponse> {
  const limit = query.limit;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) {
    throw new BadRequestError("Invalid cursor");
  }

  const filterUnreadOnly = query.filter === "unread";
  const filterWatchingOnly = query.watching === true;
  const engagementPredicate = ENGAGEMENT_VIEW_PREDICATE[query.engagement];
  const originPredicate = query.origin ? originsFilterSql(query.origin) : sql`TRUE`;
  const participantsPredicate = query.with ? participantsFilterSql(query.with) : sql`TRUE`;

  // Cursor predicate (sort: last_message_at DESC NULLS LAST, chat_id DESC).
  // See the original commentary in git history for the case-by-case
  // analysis — preserved verbatim from the pre-refactor implementation
  // because the entity-layer (chats) sort key has not changed.
  // postgres-js can't serialize a JS Date through a raw sql template
  // without column metadata; pre-stringify to ISO so the param goes
  // through as text and the `::timestamptz` cast handles the rest.
  const cursorTsIso = cursor?.lastMessageAt ? cursor.lastMessageAt.toISOString() : null;
  const cursorPredicate = !cursor
    ? sql`TRUE`
    : cursor.lastMessageAt === null
      ? sql`(c.last_message_at IS NULL AND c.id < ${cursor.chatId})`
      : sql`(c.last_message_at IS NULL
             OR c.last_message_at < ${cursorTsIso}::timestamptz
             OR (c.last_message_at = ${cursorTsIso}::timestamptz AND c.id < ${cursor.chatId}))`;

  // postgres-js returns timestamptz as ISO strings when bound through
  // a raw sql template; coerce below so the response uses ISO
  // strings consistently.
  const rawRows = (await db.execute(sql`
    SELECT
      c.id                  AS chat_id,
      c.type                AS type,
      c.topic               AS topic,
      c.parent_chat_id      AS parent_chat_id,
      c.last_message_at     AS last_message_at,
      c.last_message_preview AS last_message_preview,
      (SELECT count(*) FROM chat_membership
        WHERE chat_id = c.id AND access_mode = 'speaker') AS participant_count,
      cm.access_mode AS access_mode,
      COALESCE(cus.unread_mention_count, 0) AS unread_mention_count,
      COALESCE(cus.engagement_status, ${ACTIVE}) AS engagement_status,
      ${chatSourceSqlExpression} AS source,
      c.metadata->>'entityType' AS entity_type
      FROM chats c
      JOIN chat_membership cm
        ON cm.chat_id = c.id AND cm.agent_id = ${humanAgentId}
      LEFT JOIN chat_user_state cus
        ON cus.chat_id = c.id AND cus.agent_id = ${humanAgentId}
     WHERE c.parent_chat_id IS NULL
       /* Scope to the caller's org. Without this, cross-org dirty
          chats whose chat_membership still references the caller's
          human agent (historical pollution — see
          fix/cross-org-direct-chat-pollution) would leak into the
          list and 404 on click via requireChatAccess. */
       AND c.organization_id = ${organizationId}
       AND (${!filterUnreadOnly}::bool OR COALESCE(cus.unread_mention_count, 0) > 0)
       AND (${!filterWatchingOnly}::bool OR cm.access_mode = 'watcher')
       AND ${engagementPredicate}
       AND ${originPredicate}
       AND ${participantsPredicate}
       AND ${cursorPredicate}
     ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
     LIMIT ${limit + 1}
  `)) as unknown as Array<{
    chat_id: string;
    type: string;
    topic: string | null;
    parent_chat_id: string | null;
    last_message_at: Date | string | null;
    last_message_preview: string | null;
    participant_count: number | string;
    access_mode: "speaker" | "watcher";
    unread_mention_count: number;
    engagement_status: ChatEngagementStatus;
    source: ChatSource;
    entity_type: string | null;
  }>;

  const toDate = (v: Date | string | null): Date | null => {
    if (v === null) return null;
    return v instanceof Date ? v : new Date(v);
  };

  const hasMore = rawRows.length > limit;
  const pageRaw = hasMore ? rawRows.slice(0, limit) : rawRows;
  const last = pageRaw[pageRaw.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(toDate(last.last_message_at), last.chat_id) : null;

  if (pageRaw.length === 0) return { rows: [], nextCursor: null };

  const chatIds = pageRaw.map((r) => r.chat_id);

  // Lookup participants (speakers only — watchers do not appear in
  // the conversation row's participant chip list). The leftJoin to
  // `agent_chat_sessions` is keyed on BOTH (agent_id, chat_id) so each
  // row sees the session state for *this* chat — never another chat the
  // same agent happens to speak in. PK on agent_chat_sessions is
  // (agent_id, chat_id), so the join is a row-by-row PK lookup with no
  // extra index needed.
  //
  // The previous implementation joined `agent_presence.runtime_state`
  // (agent-global). That made `workingAgentIds` light up on every chat
  // an agent participated in whenever it worked in any one of them —
  // the cross-chat false-positive #366 self-described as "Option A".
  const participantRows = await db
    .select({
      chatId: chatMembership.chatId,
      agentId: chatMembership.agentId,
      displayName: agents.displayName,
      type: agents.type,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      sessionState: agentChatSessions.state,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .leftJoin(
      agentChatSessions,
      and(eq(agentChatSessions.agentId, chatMembership.agentId), eq(agentChatSessions.chatId, chatMembership.chatId)),
    )
    .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.accessMode, "speaker")));

  const participantsByChat = new Map<string, MeChatRow["participants"]>();
  const engagedByChat = new Map<string, string[]>();
  for (const p of participantRows) {
    const list = participantsByChat.get(p.chatId) ?? [];
    list.push({
      agentId: p.agentId,
      displayName: p.displayName,
      type: p.type,
      avatarColorToken: p.avatarColorToken,
      // Chat list intentionally retains the agent-only avatar path — it
      // does NOT fall back to `users.avatar_url` for human participants.
      // The detail-view surfaces (message bubbles, ParticipantsHeader)
      // use `resolveAvatarImageUrl` via `/agents` / `/me/managed-agents`
      // and DO honor the human → GitHub fallback. Keep the chat row
      // unchanged so the existing visual contract (first-letter / hue
      // for humans without an upload) stays stable.
      avatarImageUrl: agentAvatarImageUrl(p.agentId, p.avatarImageUpdatedAt),
    });
    participantsByChat.set(p.chatId, list);
    if (p.sessionState === "active") {
      const engaged = engagedByChat.get(p.chatId) ?? [];
      engaged.push(p.agentId);
      engagedByChat.set(p.chatId, engaged);
    }
  }

  // Live activity — derived from each chat's latest `session_events` row.
  // One LATERAL JOIN seeks the latest event per (agent, chat) pair via
  // the unique index `uq_session_events_chat_seq (agent_id, chat_id,
  // seq)`. See `deriveLiveActivity` for the query shape and the index
  // notes. Stale events (older than `LIVE_ACTIVITY_STALE_MS`) and
  // turn-terminal kinds (`turn_end`, `error`) are filtered out at
  // derivation time so the wire payload already represents "is
  // currently working".
  const liveActivityByChat = await deriveLiveActivity(db, chatIds);

  // First-message lookup for auto-title fallback. Mirrors
  // `session.ts:listAgentSessions`'s `selectDistinctOn` pattern. The
  // logic is the same as before the schema refactor — first-message
  // resolution is a `messages` concern, independent of the membership
  // tables.
  const firstMessageRows =
    chatIds.length > 0
      ? await db
          .selectDistinctOn([messages.chatId], { chatId: messages.chatId, content: messages.content })
          .from(messages)
          .where(inArray(messages.chatId, chatIds))
          .orderBy(messages.chatId, messages.createdAt)
      : [];

  const firstMessageSummary = new Map<string, string>();
  for (const row of firstMessageRows) {
    const s = extractSummary(row.content);
    if (s) firstMessageSummary.set(row.chatId, s);
  }

  const rows: MeChatRow[] = pageRaw.map((r) => {
    const participants = participantsByChat.get(r.chat_id) ?? [];
    const title = resolveChatTitle(r.topic, firstMessageSummary.get(r.chat_id) ?? null, participants, humanAgentId);
    const isSpeaker = r.access_mode === "speaker";
    // Narrow the raw `metadata->>'entityType'` text to the
    // `GithubEntityType` literal union when it matches a known value,
    // otherwise null. Github rows always have a `entityType` set by
    // the webhook writer (see `chat-metadata.ts`'s discriminated
    // union); the explicit narrowing rejects values we don't ship —
    // e.g. metadata hand-edited via SQL or an in-flight rollout that
    // introduces a new entity type before shared/web learn about it.
    const entityType: MeChatRow["entityType"] =
      r.source === "github" && r.entity_type !== null && isKnownGithubEntityType(r.entity_type) ? r.entity_type : null;
    return {
      chatId: r.chat_id,
      type: r.type,
      membershipKind: isSpeaker ? "participant" : "watching",
      source: r.source,
      entityType,
      title,
      topic: r.topic,
      participants,
      participantCount: Number(r.participant_count),
      lastMessageAt: toDate(r.last_message_at)?.toISOString() ?? null,
      lastMessagePreview: r.last_message_preview,
      unreadMentionCount: r.unread_mention_count,
      canReply: isSpeaker,
      engagementStatus: r.engagement_status,
      engagedAgentIds: engagedByChat.get(r.chat_id) ?? [],
      liveActivity: liveActivityByChat.get(r.chat_id) ?? null,
    };
  });

  return { rows, nextCursor };
}

// ---------------------------------------------------------------------------
// Live activity derivation
// ---------------------------------------------------------------------------

/**
 * Per-chat live activity, derived from the most recent `session_events` row.
 *
 * Returns a chatId → LiveActivity map; chats with no activity (or where the
 * latest event is terminal / stale) are absent from the map (caller treats
 * absence as null).
 */
export async function deriveLiveActivity(db: Database, chatIds: string[]): Promise<Map<string, LiveActivity>> {
  if (chatIds.length === 0) return new Map();

  // Per-pair seek via LATERAL: `agent_chat_sessions` is the (agent_id,
  // chat_id) directory (PK = the same pair). For each pair we look up
  // *the* newest event via the unique index `uq_session_events_chat_seq
  // (agent_id, chat_id, seq)` — a backward index scan with `LIMIT 1`
  // costs one B-tree descent per pair, independent of how many events
  // the pair has accumulated.
  //
  // The naive shape `SELECT DISTINCT ON ... FROM session_events WHERE
  // chat_id = ANY(?)` (see PR #378 review thread) cannot use either
  // index as a seek because both lead with `agent_id`; it degrades to a
  // full scan + sort. The LATERAL form is independent of session_events
  // table size and stays cheap as the table grows.
  //
  // `state <> 'evicted'` is defensive — evicted sessions trigger
  // `clearEvents` so they shouldn't have rows, but a half-completed
  // eviction would otherwise surface stale chips here.
  // `IN (${sql.join(...)})` rather than `= ANY($1::text[])` because
  // postgres-js binds `string[]` as a flat string when the driver-level
  // type hint resolves to `text[]`, which PG rejects (`malformed array
  // literal`). Inlining each value as its own placeholder is equivalent
  // shape-wise and sidesteps the binding mismatch.
  const chatIdInClause = sql.join(
    chatIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rawRows = (await db.execute(sql`
    SELECT acs.agent_id        AS agent_id,
           acs.chat_id         AS chat_id,
           e.kind              AS kind,
           e.payload           AS payload,
           e.created_at        AS created_at
      FROM agent_chat_sessions acs
      CROSS JOIN LATERAL (
        SELECT kind, payload, created_at, seq
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
         ORDER BY se.seq DESC
         LIMIT 1
      ) e
     WHERE acs.chat_id IN (${chatIdInClause})
       AND acs.state <> 'evicted'
  `)) as unknown as Array<{
    agent_id: string;
    chat_id: string;
    kind: string;
    payload: unknown;
    created_at: Date | string;
  }>;
  const rows = rawRows.map((r) => ({
    agent_id: r.agent_id,
    chat_id: r.chat_id,
    kind: r.kind,
    payload: r.payload,
    created_at: r.created_at,
  }));

  const now = Date.now();
  const byChat = new Map<string, { activity: LiveActivity; createdAtMs: number }>();
  for (const row of rows) {
    const activity = toLiveActivity(row);
    if (!activity) continue;
    const createdAtMs = new Date(row.created_at).getTime();
    if (now - createdAtMs > LIVE_ACTIVITY_STALE_MS) continue;
    // Multiple agents may produce events for the same chat — keep the
    // freshest one. DISTINCT ON already collapses per (agent, chat) pair;
    // here we collapse across agents within the same chat.
    const existing = byChat.get(row.chat_id);
    if (!existing || createdAtMs > existing.createdAtMs) {
      byChat.set(row.chat_id, { activity, createdAtMs });
    }
  }

  const out = new Map<string, LiveActivity>();
  for (const [chatId, { activity }] of byChat) out.set(chatId, activity);
  return out;
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
  switch (row.kind) {
    case "tool_call": {
      const payload = (row.payload ?? {}) as Partial<ToolCallEventPayload>;
      const label = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : "Tool";
      return { agentId: row.agent_id, kind: "tool_call", label, startedAt };
    }
    case "thinking":
      return { agentId: row.agent_id, kind: "thinking", label: "Thinking", startedAt };
    case "assistant_text":
      return { agentId: row.agent_id, kind: "assistant_text", label: "Writing", startedAt };
    default:
      // turn_end / error / unknown → no live indicator
      return null;
  }
}

/**
 * Title resolution priority:
 *
 *   1. `chat.topic` (manual, set via `PATCH /chats/:chatId`)
 *   2. First message summary (auto, ≤ 50 chars from `extractSummary`)
 *   3. Participant join (fallback when chat has no messages yet)
 */
export function resolveChatTitle<P extends { agentId: string; displayName: string }>(
  topic: string | null,
  firstMessageSummary: string | null,
  participants: ReadonlyArray<P>,
  selfAgentId: string,
): string {
  if (topic && topic.length > 0) return topic;
  if (firstMessageSummary && firstMessageSummary.length > 0) return firstMessageSummary;
  const others = participants.filter((p) => p.agentId !== selfAgentId);
  if (others.length === 0) return "Empty chat";
  if (others.length <= 3) return others.map((p) => p.displayName).join(", ");
  return `${others[0]?.displayName}, ${others[1]?.displayName} +${others.length - 2}`;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createMeChat(
  db: Database,
  humanAgentId: string,
  organizationId: string,
  body: CreateMeChat,
): Promise<{ chatId: string }> {
  const distinctIds = [...new Set(body.participantIds)].filter((id) => id !== humanAgentId);
  if (distinctIds.length === 0) {
    throw new BadRequestError("At least one non-self participant required");
  }

  const allIds = [humanAgentId, ...distinctIds];
  const found = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      visibility: agents.visibility,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(inArray(agents.uuid, allIds));

  if (found.length !== allIds.length) {
    const foundSet = new Set(found.map((a) => a.uuid));
    const missing = allIds.filter((id) => !foundSet.has(id));
    throw new BadRequestError(`Agents not found: ${missing.join(", ")}`);
  }
  const crossOrg = found.filter((a) => a.organizationId !== organizationId);
  if (crossOrg.length > 0) {
    throw new BadRequestError(`Cross-organization chat not allowed: ${crossOrg.map((a) => a.uuid).join(", ")}`);
  }

  // Owner-exclusive rule for private agents (creation path, mirroring
  // the add-participant gate in `addMeChatParticipants`). The caller
  // agent's `managerId` is its owning member — looking it up from
  // `found` (rather than accepting it as a parameter) keeps the
  // owner-id source-of-truth inside the service. RFC §4.4.2 / §4.5.
  const caller = found.find((a) => a.uuid === humanAgentId);
  if (!caller) {
    throw new BadRequestError("Caller agent not found in the chat's organization");
  }
  const privateNotOwned = found.filter(
    (a) => a.uuid !== humanAgentId && a.visibility === AGENT_VISIBILITY.PRIVATE && a.managerId !== caller.managerId,
  );
  if (privateNotOwned.length > 0) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${privateNotOwned.map((a) => a.uuid).join(", ")}`,
    );
  }

  // Hub keeps a single group-chat model (see first-tree-context PR #281).
  // New chats are always `group`, regardless of participant count — the
  // historical `direct` write path is gone. Reads still derive 1:1 / agent-
  // only behaviour from membership shape (see Task 1.F), so existing
  // `type='direct'` rows continue to behave correctly.
  const chatType = "group";

  const chatId = randomUUID();
  const topic = body.topic ?? null;

  await db.transaction(async (tx) => {
    await tx.insert(chats).values({
      id: chatId,
      organizationId,
      type: chatType,
      topic,
    });

    // v2: mode is decision-inert; `addChatParticipants` writes the
    // constant `'mention_only'` for every speaker row. The single-writer
    // entrypoint is retained so a future per-receiver wake policy lands
    // in one place. See
    // proposals/hub-chat-message-v2-simplify-mode.20260520.md.
    await addChatParticipants(
      tx,
      chatId,
      allIds.map((agentId) => ({
        agentId,
        role: agentId === humanAgentId ? ("owner" as const) : ("member" as const),
      })),
    );

    // Add watcher rows for managers of any non-human participant.
    // Idempotent.
    await recomputeChatWatchers(tx, chatId);
  });

  // Fresh chat — no cache entry exists yet, but populate consistency
  // for the rare case a `chat:message` dispatch races with creation.
  invalidateChatAudience(chatId);
  return { chatId };
}

// ---------------------------------------------------------------------------
// Add participants
// ---------------------------------------------------------------------------

export async function addMeChatParticipants(
  db: Database,
  chatId: string,
  callerHumanAgentId: string,
  callerOrganizationId: string,
  body: AddMeChatParticipants,
): Promise<void> {
  const distinct = [...new Set(body.participantIds)];
  if (distinct.length === 0) throw new BadRequestError("At least one participant required");

  const [chat] = await db
    .select({ id: chats.id, organizationId: chats.organizationId, type: chats.type })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);

  // Caller-side authorisation. 404 (not 403) for "cannot see this
  // chat" so non-participants cannot probe chat existence by uuid.
  // Two gates: (1) chat lives in caller's active org; (2) caller is a
  // speaking participant (watchers cannot invite speakers).
  if (chat.organizationId !== callerOrganizationId) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  // Resolve caller's chat-membership AND owner member-id in one query.
  // The owner member-id is the authoritative input to the
  // owner-exclusive check below — deriving it from the caller agent's
  // `managerId` (rather than accepting it as a parameter) prevents an
  // internal caller from mismatching the two and bypassing the check.
  // Works regardless of caller agent type: a human agent's managerId
  // is its own member; an autonomous/personal_assistant agent's
  // managerId is the member that owns it.
  const [callerRow] = await db
    .select({ ownerMemberId: agents.managerId })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, callerHumanAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!callerRow) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  const callerMemberId = callerRow.ownerMemberId;

  const found = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      visibility: agents.visibility,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(inArray(agents.uuid, distinct));

  if (found.length !== distinct.length) {
    const foundSet = new Set(found.map((a) => a.uuid));
    const missing = distinct.filter((id) => !foundSet.has(id));
    throw new BadRequestError(`Agents not found: ${missing.join(", ")}`);
  }
  const crossOrg = found.filter((a) => a.organizationId !== chat.organizationId);
  if (crossOrg.length > 0) {
    throw new BadRequestError(`Cross-organization participant rejected: ${crossOrg.map((a) => a.uuid).join(", ")}`);
  }

  // Owner-exclusive rule for private agents. Only the agent's manager
  // (the owner) can pull a private agent into a chat — inviting it into
  // the chat is the owner's own scoped "consent" to expose it to other
  // members. Mirrors the "邀请即同意 / Owner-exclusive" property in
  // `docs/agent-space-and-mention-visibility-design.zh-CN.md` §4.4.2 /
  // §4.5, and prevents anyone with an agent's UUID from bypassing the
  // discovery filter to drop someone else's private agent into a chat.
  // Living at the service layer (not just the API caller-side
  // `assertAllAgentsVisibleInOrg` gate) so the invariant holds for any
  // future entrypoint that builds on this service.
  const privateNotOwned = found.filter(
    (a) => a.visibility === AGENT_VISIBILITY.PRIVATE && a.managerId !== callerMemberId,
  );
  if (privateNotOwned.length > 0) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${privateNotOwned.map((a) => a.uuid).join(", ")}`,
    );
  }

  await db.transaction(async (tx) => {
    // Existing speakers (for the direct → group upgrade rule and
    // for filtering out already-speaking agents from the insert
    // batch).
    const existingSpeakers = await tx
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
    const existingSpeakerSet = new Set(existingSpeakers.map((e) => e.agentId));
    const toUpsert = distinct.filter((id) => !existingSpeakerSet.has(id));
    if (toUpsert.length === 0) {
      // Idempotent — nothing to do, but still recompute watchers in
      // case the caller is fixing a stale watcher set.
      await recomputeChatWatchers(tx, chatId);
      return;
    }

    // v2: no chat-type flip needed — `chats.type` is locked to 'group' and
    // `chat_membership.mode` is decision-inert. `upgradeWatcherToSpeaker:
    // true` promotes any pre-existing watcher row in place — chat_user_state
    // lives in a separate table so the user's read state survives the
    // promotion untouched (no state-carry transaction needed).
    await addChatParticipants(
      tx,
      chatId,
      toUpsert.map((agentId) => ({ agentId, role: "member" as const })),
      { upgradeWatcherToSpeaker: true },
    );

    await recomputeChatWatchers(tx, chatId);
  });

  // Bust the WS audience cache so the next `chat:message` dispatch
  // resolves the fresh speaker set.
  invalidateChatAudience(chatId);
}

// ---------------------------------------------------------------------------
// Mark read
// ---------------------------------------------------------------------------

export async function markMeChatRead(db: Database, chatId: string, humanAgentId: string): Promise<MeChatReadResponse> {
  const now = new Date();
  // Single-table UPSERT into chat_user_state. Lazy materialisation —
  // the row is created on first markRead if it didn't already exist.
  await db
    .insert(chatUserState)
    .values({
      chatId,
      agentId: humanAgentId,
      lastReadAt: now,
      unreadMentionCount: 0,
    })
    .onConflictDoUpdate({
      target: [chatUserState.chatId, chatUserState.agentId],
      set: {
        lastReadAt: now,
        unreadMentionCount: 0,
      },
    });

  return { chatId, lastReadAt: now.toISOString(), unreadMentionCount: 0 };
}

// ---------------------------------------------------------------------------
// Mark unread
// ---------------------------------------------------------------------------

/**
 * Bump `unread_mention_count` to at least 1 so the chat shows up as unread
 * in the conversation list (and is matched by `?filter=unread`). Idempotent:
 * if the row already has a positive count, it stays as-is. `last_read_at`
 * is intentionally untouched — this is a UI affordance, not a "rewind the
 * read cursor" operation.
 *
 * Contract note — semantic overload: the column is named `unread_mention_count`
 * but is co-opted here as a generic "manual unread" flag. Every existing
 * consumer (conversation list bold styling, `?filter=unread`, source-counts,
 * the bell badge) only checks `> 0`, so the exact value carries no meaning
 * for callers. If a future feature ever renders the literal mention count
 * (e.g. a "N mentions" pill), it must NOT read this column directly — it
 * needs a separate mention-only counter, otherwise a manually-marked-unread
 * chat would show a fictitious "1 mention".
 */
export async function markMeChatUnread(
  db: Database,
  chatId: string,
  humanAgentId: string,
): Promise<MeChatUnreadResponse> {
  await db
    .insert(chatUserState)
    .values({
      chatId,
      agentId: humanAgentId,
      unreadMentionCount: 1,
    })
    .onConflictDoUpdate({
      target: [chatUserState.chatId, chatUserState.agentId],
      set: {
        unreadMentionCount: sql`GREATEST(${chatUserState.unreadMentionCount}, 1)`,
      },
    });

  const [row] = await db
    .select({ unreadMentionCount: chatUserState.unreadMentionCount })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, humanAgentId)))
    .limit(1);

  return { chatId, unreadMentionCount: row?.unreadMentionCount ?? 1 };
}

// ---------------------------------------------------------------------------
// Join / Leave
// ---------------------------------------------------------------------------

export async function joinMeChat(db: Database, chatId: string, humanAgentId: string): Promise<void> {
  const membership = await resolveChatMembership(db, chatId, humanAgentId);
  ensureCanJoin(membership);
  await joinAsParticipant(db, chatId, humanAgentId);
  invalidateChatAudience(chatId);
}

export async function leaveMeChat(db: Database, chatId: string, humanAgentId: string): Promise<MeChatLeaveResponse> {
  const result = await leaveAsParticipant(db, chatId, humanAgentId);
  invalidateChatAudience(chatId);
  return result;
}

// ---------------------------------------------------------------------------
// "Total unread chats" — small helper for the conversation list badge
// ---------------------------------------------------------------------------

/**
 * Used by future bell-badge / list-pill counts. The partial index
 * `idx_user_state_unread WHERE unread_mention_count > 0` bounds the
 * driving scan; we then join `chat_membership` + `chats` so the badge
 * stays consistent with `listMeChats`.
 *
 * Why the joins (not just a single-table count): per §11.4 a user's
 * `chat_user_state` row is **preserved on detach** so read state
 * survives a leave/rejoin cycle. Without the membership join, any
 * preserved row with `unread_mention_count > 0` would keep
 * contributing to the badge even though the chat no longer appears in
 * the list. The `chats` join applies the same org-scoping +
 * `parent_chat_id IS NULL` filter as `listMeChats` so the two counts
 * cannot drift in the cross-org pollution or nested-chat cases either.
 *
 * Engagement parity: deleted chats are excluded from `listMeChats`
 * (any `engagement` view), so the badge must exclude them too — otherwise
 * the user sees an unread red dot for a chat they've removed from view.
 */
/**
 * Per-source aggregate for the conversation-list tag bar.
 *
 * Returns one row per source the caller has at least one chat for, plus an
 * always-present `manual` entry (zero counts when there are no manual chats —
 * the workspace UI uses `manual` as its default tab and must render it even
 * when empty).
 *
 * Filtering matches `listMeChats` for the corresponding tab so the badges
 * cannot drift from the list: same membership join, same `parent_chat_id IS
 * NULL` and `organization_id` scopes, same engagement view, same
 * `chat_user_state.unread_mention_count` source.
 */
export async function listMeChatSourceCounts(
  db: Database,
  humanAgentId: string,
  organizationId: string,
  query: ListMeChatSourceCountsQuery,
): Promise<MeChatSourceCounts> {
  const engagementPredicate = ENGAGEMENT_VIEW_PREDICATE[query.engagement];

  // GROUP BY 1 (select-list position) instead of the `source` alias or the
  // full CASE: `GROUP BY <alias>` doesn't transitively treat columns inside
  // the aliased expression as grouped (PG reports `c.metadata` un-grouped),
  // and `GROUP BY <CASE>` fails when the CASE arms are parameterised — the
  // ungrouped-column analyser treats two textually-different parameter
  // bindings as distinct expressions even when they reduce to the same
  // value. Ordinal position works in both cases.
  // Aggregate semantics:
  //   - chat_count: COUNT of rows in the membership join (matches what the
  //     paginated list would return for this source).
  //   - unread_chat_count: COUNT of those rows where the user's
  //     unread_mention_count > 0. Deliberately a count of chats, NOT a SUM
  //     of mention counts, so the tag badge matches the existing
  //     `totalUnread` pill in the conversation list ("N chats with unread").
  //   - Membership join (no `cm.access_mode` filter) intentionally counts
  //     watcher rows as well: watcher chats appear in `listMeChats`, so
  //     omitting them here would let a watcher-only PR chat disappear from
  //     the tag bar but show up in the list when filtered.
  const rows = (await db.execute(sql`
    SELECT
      ${chatSourceSqlExpression} AS source,
      count(*)::int AS chat_count,
      count(*) FILTER (WHERE COALESCE(cus.unread_mention_count, 0) > 0)::int AS unread_chat_count
      FROM chats c
      JOIN chat_membership cm
        ON cm.chat_id = c.id AND cm.agent_id = ${humanAgentId}
      LEFT JOIN chat_user_state cus
        ON cus.chat_id = c.id AND cus.agent_id = ${humanAgentId}
     WHERE c.parent_chat_id IS NULL
       AND c.organization_id = ${organizationId}
       AND ${engagementPredicate}
     GROUP BY 1
  `)) as unknown as Array<{
    source: ChatSource;
    chat_count: number;
    unread_chat_count: number;
  }>;

  const counts: MeChatSourceCounts["counts"] = {};
  for (const row of rows) {
    counts[row.source] = {
      chatCount: Number(row.chat_count),
      unreadChatCount: Number(row.unread_chat_count),
    };
  }
  // `manual` is always rendered as the default tab — surface it even at zero
  // counts so the client doesn't have to special-case the empty workspace.
  if (!counts.manual) {
    counts.manual = { chatCount: 0, unreadChatCount: 0 };
  }
  return { counts };
}

export async function countUnreadMeChats(db: Database, humanAgentId: string, organizationId: string): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
      FROM chat_user_state cus
      JOIN chat_membership cm
        ON cm.chat_id = cus.chat_id AND cm.agent_id = cus.agent_id
      JOIN chats c
        ON c.id = cus.chat_id
     WHERE cus.agent_id = ${humanAgentId}
       AND cus.unread_mention_count > 0
       AND COALESCE(cus.engagement_status, ${ACTIVE}) <> ${DELETED}
       AND c.parent_chat_id IS NULL
       AND c.organization_id = ${organizationId}
  `);
  return rows[0]?.count ?? 0;
}
