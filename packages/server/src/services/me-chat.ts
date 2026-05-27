/**
 * Member-facing chat service backing `/me/chats*` endpoints (chat-first
 * workspace).
 *
 * Responsibilities:
 *   - Cursor-paginated conversation list (single-stream JOIN over the
 *     unified `chat_membership` + `chat_user_state` tables).
 *   - Create a new chat (delegates participant writes — and the derived
 *     watcher recompute — to `addChatParticipants`).
 *   - Add participants (delegates to `inviteParticipantsToChat`).
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
  CHAT_ENGAGEMENT_STATUSES,
  type ChatEngagementStatus,
  type ChatEngagementView,
  type ChatSource,
  type CreateMeChat,
  GITHUB_ENTITY_TYPES,
  type GithubEntityType,
  type ListMeChatSourceCountsQuery,
  type ListMeChatsQuery,
  type ListMeChatsResponse,
  type LiveActivity,
  type MeChatLeaveResponse,
  type MeChatReadResponse,
  type MeChatRow,
  type MeChatSourceCounts,
  type MeChatUnreadResponse,
} from "@first-tree/shared";
import { and, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, CallerNotSpeakerError, ForbiddenError, NotFoundError } from "../errors.js";
import { agentAvatarImageUrl } from "./agent.js";
import { resolveAgentChatStatuses } from "./agent-chat-status.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import {
  assertChatVisibleInOrgOrNotFound,
  inviteParticipantsToChat,
  rejectedPrivateTargets,
} from "./participant-invite.js";
import { addChatParticipants } from "./participant-mode.js";
import { extractSummary } from "./session.js";
import { ensureCanJoin, joinAsParticipant, leaveAsParticipant, resolveChatMembership } from "./watcher.js";

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
  callerMemberId: string,
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
  //
  // The `chat_has_explicit_mention_to_me` correlated subquery scans the
  // caller's unread window (`m.created_at > last_read_at`) for any message
  // whose `metadata.mentions` JSONB array contains the caller's
  // human-agent uuid. Distinguishes explicit `@<me>` from the v1 1-on-1
  // implicit DM auto-mention (services/message.ts:282 `dmAutoProjection`),
  // which bumps `unread_mention_count` for the red dot but never writes
  // the recipient into `metadata.mentions`. Uses the existing
  // `idx_messages_chat_time` for the chat+window scan.
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
      c.metadata->>'entityType' AS entity_type,
      EXISTS (
        SELECT 1 FROM messages m
         WHERE m.chat_id = c.id
           AND m.created_at > COALESCE(cus.last_read_at, '-infinity'::timestamptz)
           AND m.metadata -> 'mentions' @> jsonb_build_array(${humanAgentId}::text)
      ) AS chat_has_explicit_mention_to_me
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
    chat_has_explicit_mention_to_me: boolean;
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

  // Lookup participants (speakers only — watchers do not appear in the
  // conversation row's participant chip list). Drives the participant chips
  // AND the per-chat non-human speaker set the status projections filter on.
  const participantRows = await db
    .select({
      chatId: chatMembership.chatId,
      agentId: chatMembership.agentId,
      displayName: agents.displayName,
      type: agents.type,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.accessMode, "speaker")));

  const participantsByChat = new Map<string, MeChatRow["participants"]>();
  // Per-chat non-human speaker set — the filter for the failed / live-dot
  // projections below (pending is intentionally NOT speaker-filtered).
  const nonHumanSpeakersByChat = new Map<string, Set<string>>();
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
    if (p.type !== "human") {
      let s = nonHumanSpeakersByChat.get(p.chatId);
      if (!s) {
        s = new Set();
        nonHumanSpeakersByChat.set(p.chatId, s);
      }
      s.add(p.agentId);
    }
  }

  // One producer for every per-(agent,chat) status signal this list needs
  // (live-dot / failed / needs-you), shared with `GET /chats/:id/agent-status`.
  // `withTurnText: false` — the chat-list never renders the turn narration
  // (only the compose status bar does). Each signal is projected below.
  const statusByChat = await resolveAgentChatStatuses(db, chatIds, { withTurnText: false });

  // Manager-scope: non-human agent UUIDs the caller manages
  // (`agents.manager_id = caller.member_id`). Drives the "mine" narrowing on
  // the `failedAgentIds` / `pendingQuestionAgentIds` projections below — so a
  // watcher (or peer speaker) is no longer pinned into "Needs attention" by
  // someone else's broken / waiting agent.
  //
  // The `ne(type, 'human')` guard excludes the caller's own human agent (which
  // is self-managed, `manager_id = caller.member_id` per `createTestAdmin` /
  // `createMember`). Today the downstream projection is safe regardless —
  // `resolveAgentChatStatuses` already filters non-human, so a human agent in
  // this set never reaches the loop. The guard is defensive: if a future
  // change ever surfaces human statuses (e.g. an "adapter offline" signal),
  // we don't want the caller's own human agent's main accidentally flowing
  // into `failedAgentIds`. Belt-and-braces flagged in PR #579 review.
  //
  // One indexed read via `idx_agents_manager`. Filtering by `manager_id` alone
  // (no `organization_id` clause) is sufficient — `members.id` is unique per
  // (user, org) so any agent whose manager is `callerMemberId` is necessarily
  // in the caller's org. An extra `organization_id` clause would silently drop
  // a legitimate "mine" agent in the (rare) case where the create-time
  // invariant `agents.organization_id == manager.organization_id` was broken
  // by a buggy admin path. Read-side trusts the invariant; write-side guards.
  //
  // See docs/development/needs-attention-scoping.20260526.md.
  const managedRows = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.managerId, callerMemberId), ne(agents.type, "human")));
  const managedAgentIds = new Set(managedRows.map((r) => r.uuid));

  const liveActivityByChat = new Map<string, LiveActivity>();
  const failedByChat = new Map<string, string[]>();
  const pendingByChat = new Map<string, string[]>();
  const busyByChat = new Map<string, string[]>();
  const hasOpenQuestionByChat = new Map<string, boolean>();
  for (const [chatId, statuses] of statusByChat) {
    const speakers = nonHumanSpeakersByChat.get(chatId);
    // live-dot: freshest activity among non-human SPEAKERS. (Narrowed from the
    // old session-holder source — drops stray dots from agents that left the
    // chat, and never lights for a human predictive-active session.)
    let freshest: { activity: LiveActivity; startedMs: number } | null = null;
    const failed: string[] = [];
    const pending: string[] = [];
    const busy: string[] = [];
    for (const s of statuses) {
      const isSpeaker = speakers?.has(s.agentId) ?? false;
      const isMine = managedAgentIds.has(s.agentId);
      if (isSpeaker && s.activity) {
        const startedMs = new Date(s.activity.startedAt).getTime();
        if (!freshest || startedMs > freshest.startedMs) freshest = { activity: s.activity, startedMs };
      }
      // failed — speaker-filtered AND narrowed to "mine" (R1). A peer's broken
      // agent in a chat I'm in no longer pins my row to "Needs attention".
      if (isSpeaker && s.main === "failed" && isMine) failed.push(s.agentId);
      // busy = speakers with composite `working` (the D-axis truth from
      // `agent_chat_sessions.runtime_state`). Drives the chat-list activity
      // indicator authoritatively, so it lights even when a runtime emits
      // no intermediate session_events (codex no-events case) — the gap
      // `liveActivity` alone can never cover. NOT narrowed to mine — "someone
      // is working" is informational, not an attention signal.
      if (isSpeaker && s.working) busy.push(s.agentId);
      // pending — NOT speaker-filtered (a pending agent that has since left
      // the chat still counts, matching the prior `derivePendingQuestions`
      // surface), AND narrowed to "mine" (R2). The front-end covers R3
      // (caller-is-speaker fallback) via the separate `chatHasOpenQuestion`
      // boolean below — which stays raw, unfiltered.
      if (s.needsYou && isMine) pending.push(s.agentId);
      // chatHasOpenQuestion — raw "any agent in this chat has a pending
      // question" bit. Feeds the front-end R3 rule (a speaker in a chat with
      // an open question is in attention even if the asking agent is someone
      // else's). Computed over the same union (non-human speakers + non-human
      // pending) that `resolveAgentChatStatuses` returns, so a pending agent
      // that has left still flips this true.
      if (s.needsYou) hasOpenQuestionByChat.set(chatId, true);
    }
    if (freshest) liveActivityByChat.set(chatId, freshest.activity);
    if (failed.length > 0) failedByChat.set(chatId, failed);
    if (pending.length > 0) pendingByChat.set(chatId, pending);
    if (busy.length > 0) busyByChat.set(chatId, busy);
  }

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
      liveActivity: liveActivityByChat.get(r.chat_id) ?? null,
      pendingQuestionAgentIds: pendingByChat.get(r.chat_id) ?? [],
      failedAgentIds: failedByChat.get(r.chat_id) ?? [],
      busyAgentIds: busyByChat.get(r.chat_id) ?? [],
      chatHasOpenQuestion: hasOpenQuestionByChat.get(r.chat_id) ?? false,
      chatHasExplicitMentionToMe: r.chat_has_explicit_mention_to_me,
    };
  });

  return { rows, nextCursor };
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

  // Owner-exclusive for private targets (RFC §4.5, shared-owner reading).
  // The route pins `humanAgentId = scope.humanAgentId`, so the caller's
  // owning member is the route caller's own member; the predicate refuses
  // any private target whose `managerId` doesn't match. Routing through
  // the shared `rejectedPrivateTargets` keeps the rule in exactly one
  // place — same discipline as `inviteParticipantsToChat` and
  // `chat.ts::createChat`. See that predicate's comment for the strict-
  // vs-shared history (PR #601 / #604).
  const caller = found.find((a) => a.uuid === humanAgentId);
  if (!caller) {
    throw new BadRequestError("Caller agent not found in the chat's organization");
  }
  const rejected = rejectedPrivateTargets(
    { agentId: humanAgentId, memberId: caller.managerId },
    found
      .filter((a) => a.uuid !== humanAgentId)
      .map((a) => ({ uuid: a.uuid, visibility: a.visibility, managerId: a.managerId })),
  );
  if (rejected.length > 0) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${rejected.map((t) => t.uuid).join(", ")}`,
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

    // v2: mode is decision-inert; `addChatParticipants` writes the constant
    // `'mention_only'` for every speaker row. The helper also encloses the
    // derived watcher recompute (so managers of any non-human participant
    // land as watchers) and the silent-context backfill (no-op here — the
    // chat has no messages yet). Don't call `recomputeChatWatchers` again.
    // See proposals/hub-chat-message-v2-simplify-mode.20260520.md.
    await addChatParticipants(
      tx,
      chatId,
      allIds.map((agentId) => ({
        agentId,
        role: agentId === humanAgentId ? ("owner" as const) : ("member" as const),
      })),
    );
  });

  // Fresh chat — no cache entry exists yet, but populate consistency
  // for the rare case a `chat:message` dispatch races with creation.
  invalidateChatAudience(chatId);
  return { chatId };
}

// ---------------------------------------------------------------------------
// Add participants
// ---------------------------------------------------------------------------

/**
 * Web entrypoint: `POST /chats/:id/participants` (user JWT).
 *
 * Thin shell over `inviteParticipantsToChat`. Two responsibilities specific
 * to the web wire shape:
 *   1. Probing-protection 404: if the chat doesn't exist OR lives in a
 *      different org from the caller, the wire surface is the same 404 so
 *      a non-member cannot probe chat existence by uuid.
 *   2. Empty-body 400 (the Layer-2 service rejects this too, but the web
 *      route prefers the early signal).
 *
 * Everything else — caller-is-speaker, cross-org targets, private
 * owner-exclusive, the actual write — is delegated. `errorOnAlreadySpeaker:
 * false` because the batch UI treats re-adding someone as a no-op.
 */
export async function addMeChatParticipants(
  db: Database,
  chatId: string,
  callerHumanAgentId: string,
  callerOrganizationId: string,
  body: AddMeChatParticipants,
): Promise<void> {
  if (body.participantIds.length === 0) {
    throw new BadRequestError("At least one participant required");
  }
  // Probing-protection 404: chat-in-caller-org. The invite service raises
  // `CallerNotSpeakerError` when the caller isn't a speaker; the web wire
  // wants both that failure mode AND chat-not-in-our-org to surface as
  // NotFound, so we pre-check the org boundary here.
  // `assertChatVisibleInOrgOrNotFound` lives next to the invite service so
  // the assertion travels with the service whose error semantics it adjusts.
  await assertChatVisibleInOrgOrNotFound(db, chatId, callerOrganizationId);

  try {
    await inviteParticipantsToChat(db, {
      chatId,
      callerAgentId: callerHumanAgentId,
      targetAgentIds: body.participantIds,
      // Web batch path is partial-idempotent: re-adding someone already in
      // the chat is a no-op (the UI doesn't model 409 per-target).
      errorOnAlreadySpeaker: false,
    });
  } catch (err) {
    // The invite service surfaces "caller is not a speaker" as a typed
    // `CallerNotSpeakerError` (subclass of `ForbiddenError`). The web wire
    // prefers `NotFoundError` to avoid leaking chat existence to non-members
    // — collapse the two failure modes (chat-in-other-org, caller-not-speaker)
    // into a single 404. Matching on the error class instead of the message
    // string means renaming the underlying error text can't silently regress
    // this remap into a 403 leak.
    if (err instanceof CallerNotSpeakerError) {
      throw new NotFoundError(`Chat "${chatId}" not found`);
    }
    throw err;
  }
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
  // `joinAsParticipant` encloses the post-commit `invalidateChatAudience`
  // call so any future caller automatically gets the cache-coherency step.
  await joinAsParticipant(db, chatId, humanAgentId);
}

export async function leaveMeChat(db: Database, chatId: string, humanAgentId: string): Promise<MeChatLeaveResponse> {
  // `leaveAsParticipant` encloses the post-commit `invalidateChatAudience`
  // call — same canonical-bundle pattern as join.
  return leaveAsParticipant(db, chatId, humanAgentId);
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
