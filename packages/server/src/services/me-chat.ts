/**
 * Member-facing chat service backing `/me/chats*` endpoints (chat-first
 * workspace).
 *
 * Responsibilities:
 *   - Cursor-paginated conversation list (single-stream JOIN over the
 *     unified `chat_membership` + `chat_user_state` tables).
 *   - Create a legacy empty Web chat via `chat.ts::createChat`.
 *   - Add participants (delegates to `inviteParticipantsToChat`).
 *   - Mark-read (UPSERT into `chat_user_state`).
 *   - Join → watcher to speaker (delegates to `watcher.ts`).
 *   - Leave → speaker to watcher or detach (delegates to `watcher.ts`).
 *
 * See proposals/chat-data-model-restructure.20260512.md §8 (schema)
 * and §11.1 (per-route mapping).
 */

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
  type MeChatPinResponse,
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
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, CallerNotSpeakerError, NotFoundError } from "../errors.js";
import { resolveAvatarImageUrl } from "./agent.js";
import { resolveAgentChatStatuses } from "./agent-chat-status.js";
import { createChat } from "./chat.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { pauseActiveJobsForOwnerChatDelete } from "./cron-job.js";
import { assertChatVisibleInOrgOrNotFound, inviteParticipantsToChat } from "./participant-invite.js";
import { extractSummary } from "./session.js";
import { ensureCanJoin, joinAsParticipant, leaveAsParticipant, resolveChatMembership } from "./watcher.js";

// ---------------------------------------------------------------------------
// Cursor encoding
// ---------------------------------------------------------------------------
//
// Cursor is `v2|<activityAtIso>|<chatId>`, base64url so it survives query
// strings. Sort ordering is `(activity_at DESC, chat_id DESC)`; `activity_at`
// is NOT NULL, so there is no null-timestamp case.

const CURSOR_VERSION = "v2";

/**
 * A decoded cursor is one of three cases so the caller can treat them
 * differently across a rollout:
 *   - `ok`     — a valid `v2|<iso>|<chatId>` cursor; resume from it.
 *   - `legacy` — a recognized PRE-PR shape (2 parts, non-empty chat id): either
 *     `<iso>|<chatId>` (a normal boundary) or `|<chatId>` (an empty timestamp,
 *     which the old encoder emitted for a `last_message_at IS NULL` tail
 *     boundary). Its timestamp meant `last_message_at`, not `activity_at`, so it
 *     can't be reinterpreted against the new ordering; a client that held one
 *     across the rollout is restarted from page 1 rather than stranded.
 *   - `invalid` — anything else (truncated / wrong-version / garbage). Kept as a
 *     typed failure (→ 400) so a genuine client/API bug still surfaces instead of
 *     being silently served page 1.
 */
type DecodedCursor = { status: "ok"; activityAt: Date; chatId: string } | { status: "legacy" } | { status: "invalid" };

export function encodeCursor(activityAt: Date, chatId: string): string {
  const payload = `${CURSOR_VERSION}|${activityAt.toISOString()}|${chatId}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return { status: "invalid" };
  }
  // Chat ids are UUIDs (never contain `|`), so a well-formed payload splits
  // cleanly: current `v2|<iso>|<chatId>` is 3 parts, legacy `<iso>|<chatId>` is 2.
  const parts = decoded.split("|");
  if (parts.length === 3) {
    const [version, tsPart, chatId] = parts;
    if (version === CURSOR_VERSION && tsPart && chatId && !Number.isNaN(new Date(tsPart).getTime())) {
      return { status: "ok", activityAt: new Date(tsPart), chatId };
    }
    return { status: "invalid" };
  }
  if (parts.length === 2) {
    const [tsPart, chatId] = parts;
    // The deployed pre-PR encoder emitted `<iso>|<chatId>` for a normal boundary
    // AND `|<chatId>` (EMPTY timestamp) for a `last_message_at IS NULL` tail
    // boundary. Recognize both exact old shapes — empty or parseable timestamp,
    // with a non-empty chat id — as legacy so every real deployed cursor takes
    // the page-1 recovery path instead of 400ing.
    if (tsPart !== undefined && chatId && (tsPart === "" || !Number.isNaN(new Date(tsPart).getTime()))) {
      return { status: "legacy" };
    }
  }
  return { status: "invalid" };
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
  if (status === "deleted") {
    await db.transaction(async (tx) => {
      const [member] = await tx
        .select({ id: members.id })
        .from(members)
        .where(eq(members.agentId, agentId))
        .limit(1);
      if (member) {
        await pauseActiveJobsForOwnerChatDelete(tx as unknown as Database, {
          controlChatId: chatId,
          ownerMemberId: member.id,
        });
      }
      await tx
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
    });
    return;
  }

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
 * Set or clear the caller's pin for this chat. UPSERT into `chat_user_state`
 * — `pinned_at = now()` to pin, `null` to unpin. Fully idempotent, including
 * the timestamp: `pinned_at` is the stable within-pinned-group sort anchor, so
 * re-pinning an already-pinned chat MUST keep the original stamp — an HTTP
 * retry or double-click must not silently reorder it. Pin is private per-user
 * state, so a write only ever touches the caller's own `(chat_id, agent_id)`
 * row and never another user's. Returns the persisted `pinned_at`.
 */
export async function pinMeChat(
  db: Database,
  chatId: string,
  agentId: string,
  pinned: boolean,
): Promise<MeChatPinResponse> {
  const now = new Date();
  const [row] = await db
    .insert(chatUserState)
    .values({ chatId, agentId, pinnedAt: pinned ? now : null })
    .onConflictDoUpdate({
      target: [chatUserState.chatId, chatUserState.agentId],
      // COALESCE keeps an existing non-null anchor and only stamps `now()` on a
      // fresh pin; unpin always clears it. (The Date is bound as an ISO string
      // + cast because a raw `sql` template can't serialize a Date directly.)
      set: { pinnedAt: pinned ? sql`COALESCE(${chatUserState.pinnedAt}, ${now.toISOString()}::timestamptz)` : null },
    })
    .returning({ pinnedAt: chatUserState.pinnedAt });
  return { chatId, pinnedAt: row?.pinnedAt?.toISOString() ?? null };
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
// origin — Manual / GitHub / Agent (one per integration/workflow, not one
// per entity type within an integration). The per-entity GitHub granularity
// (PR / Issue / Discussion / Commit) is preserved on the row via the
// separate `entity_type` SELECT so the rail's leading icon can still
// render the right glyph.
//
//   - `sourceFilterSql(source)` — WHERE predicate for `listMeChats`.
//   - `chatSourceSqlExpression` — CASE projected into the response row
//     and shared with `listMeChatSourceCounts` for the aggregate GROUP BY.
//
// Invariant: every row that `chatSourceSqlExpression` labels `github` or
// `agent` MUST also match the matching `sourceFilterSql(...)`, and vice versa. The
// classifier collapses any GitHub metadata into `github` regardless of
// the inner `entityType`, so a malformed row like
// `{source:"github", entityType:"some-new-thing"}` still lands in the
// `github` bucket — by design, since the popover-level filter doesn't
// care about the entity sub-type.

const KNOWN_NON_MANUAL_PREDICATE = sql`(c.metadata->>'source' IN ('github', 'gitlab', 'agent'))`;

const chatSourceSqlExpression = sql`CASE
    WHEN c.metadata->>'source' = 'github' THEN 'github'
    WHEN c.metadata->>'source' = 'gitlab' THEN 'gitlab'
    WHEN c.metadata->>'source' = 'agent' THEN 'agent'
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
    case "gitlab":
      return sql`(c.metadata->>'source' = 'gitlab')`;
    case "agent":
      return sql`(c.metadata->>'source' = 'agent')`;
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

const toChatDate = (v: Date | string | null): Date | null => {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
};

/**
 * Raw row shape returned by `selectMeChatRawRows` — the single-stream
 * projection every `listMeChats` sub-query (ordinary page, global pinned,
 * global attention candidates) shares so the three row sets are byte-identical
 * in shape.
 */
export type RawMeChatRow = {
  chat_id: string;
  type: string;
  topic: string | null;
  description: string | null;
  parent_chat_id: string | null;
  last_message_at: Date | string | null;
  last_message_preview: string | null;
  activity_at: Date | string | null;
  access_mode: "speaker" | "watcher";
  membership_role: string;
  unread_mention_count: number;
  open_request_count: number;
  engagement_status: ChatEngagementStatus;
  pinned_at: Date | string | null;
  source: ChatSource;
  entity_type: string | null;
  chat_has_explicit_mention_to_me: boolean;
};

/** First-wins de-dup by `chat_id` (a chat can be both pinned and an attention candidate). */
function dedupeRawByChatId(rows: RawMeChatRow[]): RawMeChatRow[] {
  const seen = new Set<string>();
  const out: RawMeChatRow[] = [];
  for (const r of rows) {
    if (seen.has(r.chat_id)) continue;
    seen.add(r.chat_id);
    out.push(r);
  }
  return out;
}

/**
 * The single-stream projection behind every `listMeChats` sub-query. Keeping
 * ONE SELECT guarantees the ordinary / pinned / attention row sets are
 * shape-identical — same columns, same source / entity / explicit-mention
 * derivation — so a chat looks the same wherever it surfaces.
 *
 * SQL strategy:
 *   - `chats JOIN chat_membership LEFT JOIN chat_user_state`. Membership
 *     carries access_mode (speaker → participant / watcher → watching); user
 *     state supplies the unread + pin + engagement columns (COALESCE defaults
 *     when the lazy row is missing).
 *   - `parent_chat_id IS NULL` — First Tree has no sub-chat product layer
 *     (first-tree-context PR #281); any historical non-null row stays hidden.
 *   - `c.organization_id = ?` — defend against historical cross-org membership
 *     pollution (fix/cross-org-direct-chat-pollution) that would otherwise leak
 *     into the list and 404 on click via `requireChatAccess`.
 *   - `chat_has_explicit_mention_to_me` scans the caller's unread window for a
 *     message whose `metadata.mentions` contains the caller's uuid,
 *     distinguishing an explicit `@me` from the v1 1-on-1 implicit DM
 *     auto-mention (services/message.ts `dmAutoProjection`).
 *
 * `filters` carries the view-scoped predicates (unread / watching / engagement
 * / origin / participants), computed once and reused verbatim so every group
 * honours the active filter identically. `extra` is the per-sub-query predicate
 * (pinned / attention-candidate / cursor + priority-exclusion). `limit === null`
 * runs unbounded — the priority groups are naturally bounded by the user's pins
 * / open requests / managed agents.
 */
async function selectMeChatRawRows(
  db: Database,
  params: {
    humanAgentId: string;
    organizationId: string;
    filters: SQL;
    extra: SQL;
    orderBy: SQL;
    limit: number | null;
  },
): Promise<RawMeChatRow[]> {
  const { humanAgentId, organizationId, filters, extra, orderBy, limit } = params;
  const limitClause = limit === null ? sql`` : sql`LIMIT ${limit}`;
  return (await db.execute(sql`
    SELECT
      c.id                  AS chat_id,
      c.type                AS type,
      c.topic               AS topic,
      c.description         AS description,
      c.parent_chat_id      AS parent_chat_id,
      c.last_message_at     AS last_message_at,
      c.last_message_preview AS last_message_preview,
      c.activity_at         AS activity_at,
      cm.access_mode AS access_mode,
      cm.role AS membership_role,
      COALESCE(cus.unread_mention_count, 0) AS unread_mention_count,
      COALESCE(cus.open_request_count, 0) AS open_request_count,
      COALESCE(cus.engagement_status, ${ACTIVE}) AS engagement_status,
      cus.pinned_at AS pinned_at,
      ${chatSourceSqlExpression} AS source,
      c.metadata->>'entityType' AS entity_type,
      CASE
        WHEN COALESCE(cus.unread_mention_count, 0) > 0 THEN EXISTS (
          SELECT 1 FROM messages m
           WHERE m.chat_id = c.id
             AND m.created_at > COALESCE(cus.last_read_at, '-infinity'::timestamptz)
             AND m.metadata -> 'mentions' @> jsonb_build_array(${humanAgentId}::text)
        )
        ELSE false
      END AS chat_has_explicit_mention_to_me
      FROM chats c
      JOIN chat_membership cm
        ON cm.chat_id = c.id AND cm.agent_id = ${humanAgentId}
      LEFT JOIN chat_user_state cus
        ON cus.chat_id = c.id AND cus.agent_id = ${humanAgentId}
     WHERE c.parent_chat_id IS NULL
       AND c.organization_id = ${organizationId}
       AND ${filters}
       AND ${extra}
     ORDER BY ${orderBy}
     ${limitClause}
  `)) as unknown as RawMeChatRow[];
}

/**
 * Run the attention-candidate query: chats matching the caller's view `filters`
 * that COULD canonically be `failed` or have an open request. A chat qualifies
 * if it has an open request OR a caller-managed non-human speaker whose stored
 * error inputs mirror `computeErrored`'s branches exactly (minus the freshness /
 * reachability the canonical resolver still applies) — a strict SUPERSET of
 * failed (no false negatives) that still excludes the common HEALTHY managed
 * speaker that would otherwise make nearly every active chat a candidate on the
 * 30s poll:
 *   - session `errored` (C-axis lifecycle) always contributes;
 *   - an active session with a per-chat runtime stamp: only the per-chat
 *     `runtime_state = 'error'` is authoritative (D-axis);
 *   - an active session with NO per-chat stamp (old client): fall back to the
 *     agent-global `presence.runtime_state = 'error'`.
 * Gating the presence fallback on `runtime_state_at IS NULL` keeps one
 * agent-global error from admitting that agent's stamped-idle chats. `failed` is
 * never decided here; the enrichment pass confirms it canonically.
 *
 * Exported so a test can observe the candidate boundary directly (no mocking).
 */
export async function selectAttentionCandidateRows(
  db: Database,
  params: { humanAgentId: string; organizationId: string; callerMemberId: string; filters: SQL; orderBy: SQL },
): Promise<RawMeChatRow[]> {
  const { humanAgentId, organizationId, callerMemberId, filters, orderBy } = params;
  const managedFailureCandidate = sql`EXISTS (
    SELECT 1 FROM chat_membership cm_s
      JOIN agents a_s ON a_s.uuid = cm_s.agent_id
      JOIN agent_chat_sessions acs ON acs.agent_id = a_s.uuid AND acs.chat_id = c.id
      LEFT JOIN agent_presence ap ON ap.agent_id = a_s.uuid
     WHERE cm_s.chat_id = c.id
       AND cm_s.access_mode = 'speaker'
       AND a_s.type <> 'human'
       AND a_s.manager_id = ${callerMemberId}
       AND (
         acs.state = 'errored'
         OR (acs.state = 'active' AND acs.runtime_state_at IS NOT NULL AND acs.runtime_state = 'error')
         OR (acs.state = 'active' AND acs.runtime_state_at IS NULL AND ap.runtime_state = 'error')
       ))`;
  return selectMeChatRawRows(db, {
    humanAgentId,
    organizationId,
    filters,
    extra: sql`(COALESCE(cus.open_request_count, 0) > 0 OR ${managedFailureCandidate})`,
    orderBy,
    limit: null,
  });
}

/**
 * Hydrate raw rows into `MeChatRow`s: participant chips, the live-dot / failed
 * / busy status projections (shared with `GET /chats/:id/agent-status`), and
 * the first-message title fallback. Returns `failedByChat` so the caller can
 * build the "Needs attention" group without re-deriving composite status in
 * SQL. `managedAgentIds` is the caller-scoped "mine" set (computed once and
 * shared across the priority + ordinary passes) that narrows `failed` to the
 * caller's own agents. `withTurnText: false` — the chat-list never renders turn
 * narration.
 */
async function enrichMeChatRows(
  db: Database,
  rawRows: RawMeChatRow[],
  params: { humanAgentId: string; managedAgentIds: ReadonlySet<string> },
): Promise<{ rows: MeChatRow[]; failedByChat: Map<string, string[]> }> {
  const { humanAgentId, managedAgentIds } = params;
  if (rawRows.length === 0) return { rows: [], failedByChat: new Map() };

  const chatIds = rawRows.map((r) => r.chat_id);

  // Speakers only — watchers do not appear in the row's participant chips. Also
  // drives the per-chat non-human speaker set the status projections filter on.
  const participantRows = await db
    .select({
      chatId: chatMembership.chatId,
      agentId: chatMembership.agentId,
      displayName: agents.displayName,
      type: agents.type,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      userAvatarUrl: users.avatarUrl,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.accessMode, "speaker")));

  const participantsByChat = new Map<string, MeChatRow["participants"]>();
  const nonHumanSpeakersByChat = new Map<string, Set<string>>();
  for (const p of participantRows) {
    const list = participantsByChat.get(p.chatId) ?? [];
    list.push({
      agentId: p.agentId,
      displayName: p.displayName,
      type: p.type,
      avatarColorToken: p.avatarColorToken,
      avatarImageUrl: resolveAvatarImageUrl({
        uuid: p.agentId,
        type: p.type,
        avatarImageUpdatedAt: p.avatarImageUpdatedAt,
        userAvatarUrl: p.userAvatarUrl,
      }),
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

  // One producer for every per-(agent,chat) status signal (live-dot / failed /
  // busy), shared with `GET /chats/:id/agent-status`.
  const statusByChat = await resolveAgentChatStatuses(db, chatIds, { withTurnText: false });

  const liveActivityByChat = new Map<string, LiveActivity>();
  const failedByChat = new Map<string, string[]>();
  const busyByChat = new Map<string, string[]>();

  for (const [chatId, statuses] of statusByChat) {
    const speakers = nonHumanSpeakersByChat.get(chatId);
    // live-dot: freshest activity among non-human SPEAKERS (drops stray dots
    // from agents that left the chat; never lights for a human session).
    let freshest: { activity: LiveActivity; startedMs: number } | null = null;
    const failed: string[] = [];
    const busy: string[] = [];
    for (const s of statuses) {
      const isSpeaker = speakers?.has(s.agentId) ?? false;
      const isMine = managedAgentIds.has(s.agentId);
      if (isSpeaker && s.activity) {
        const startedMs = new Date(s.activity.startedAt).getTime();
        if (!freshest || startedMs > freshest.startedMs) freshest = { activity: s.activity, startedMs };
      }
      // failed — speaker-filtered AND narrowed to "mine" (R1): a peer's broken
      // agent in a shared chat no longer pins my row to "Needs attention".
      if (isSpeaker && s.main === "failed" && isMine) failed.push(s.agentId);
      // busy — speakers with composite `working` (the D-axis truth from
      // `agent_chat_sessions.runtime_state`). NOT narrowed to mine — "someone
      // is working" is informational, not an attention signal.
      if (isSpeaker && s.working) busy.push(s.agentId);
    }
    if (freshest) liveActivityByChat.set(chatId, freshest.activity);
    if (failed.length > 0) failedByChat.set(chatId, failed);
    if (busy.length > 0) busyByChat.set(chatId, busy);
  }

  // First-message lookup for the auto-title fallback (only chats with no topic).
  const chatIdsNeedingFirstMessage = rawRows
    .filter((r) => r.topic === null || r.topic.length === 0)
    .map((r) => r.chat_id);
  const firstMessageRows =
    chatIdsNeedingFirstMessage.length > 0
      ? await db
          .selectDistinctOn([messages.chatId], { chatId: messages.chatId, content: messages.content })
          .from(messages)
          .where(inArray(messages.chatId, chatIdsNeedingFirstMessage))
          .orderBy(messages.chatId, messages.createdAt)
      : [];

  const firstMessageSummary = new Map<string, string>();
  for (const row of firstMessageRows) {
    const s = extractSummary(row.content);
    if (s) firstMessageSummary.set(row.chatId, s);
  }

  const rows: MeChatRow[] = rawRows.map((r) => {
    const participants = participantsByChat.get(r.chat_id) ?? [];
    const title = resolveChatTitle(r.topic, firstMessageSummary.get(r.chat_id) ?? null, participants, humanAgentId);
    const isSpeaker = r.access_mode === "speaker";
    // Narrow raw `metadata->>'entityType'` to the `GithubEntityType` union when
    // it matches a known value, else null (rejects version-skew / hand-edited
    // values).
    const entityType: MeChatRow["entityType"] =
      r.source === "github" && r.entity_type !== null && isKnownGithubEntityType(r.entity_type) ? r.entity_type : null;
    return {
      chatId: r.chat_id,
      type: r.type,
      membershipKind: isSpeaker ? "participant" : "watching",
      createdByMe: r.membership_role === "owner",
      source: r.source,
      entityType,
      title,
      topic: r.topic,
      description: r.description,
      participants,
      participantCount: participants.length,
      lastMessageAt: toChatDate(r.last_message_at)?.toISOString() ?? null,
      lastMessagePreview: r.last_message_preview,
      activityAt: toChatDate(r.activity_at)?.toISOString() ?? null,
      unreadMentionCount: r.unread_mention_count,
      openRequestCount: r.open_request_count,
      canReply: isSpeaker,
      engagementStatus: r.engagement_status,
      pinnedAt: toChatDate(r.pinned_at)?.toISOString() ?? null,
      liveActivity: liveActivityByChat.get(r.chat_id) ?? null,
      failedAgentIds: failedByChat.get(r.chat_id) ?? [],
      busyAgentIds: busyByChat.get(r.chat_id) ?? [],
      chatHasExplicitMentionToMe: r.chat_has_explicit_mention_to_me,
    };
  });

  return { rows, failedByChat };
}

/**
 * GET /me/chats — cursor-paginated conversation list with server-side priority
 * projection.
 *
 * The response carries two whole-set priority groups plus the ordinary page:
 *   1. `priorityRows.attention` — extracted across the *full* matching set (not
 *      just the loaded page): a caller-managed non-human speaker in `failed`,
 *      OR an open request to the caller. Ordered failed-first then activity DESC.
 *   2. `priorityRows.pinned` — the caller's pinned chats (private per-user
 *      state), `pinned_at` DESC, minus anything already in attention.
 *   3. `rows` — the ordinary activity-ordered keyset page on `activity_at`.
 *
 * `failed` is a composite status derived by `resolveAgentChatStatuses`, not a
 * column, so attention is built via a CANDIDATE set (open request OR a
 * caller-managed non-human speaker whose session/runtime is actually in error —
 * a strict superset of `computeErrored`'s inputs) that the enrichment pass
 * resolves canonically — never a SQL re-implementation of the status folding.
 *
 * ADDITIVE contract (deliberate, for safe rollout): `rows` is NOT filtered
 * against the priority ids. A pinned / attention chat appears in `rows` too, and
 * the client de-duplicates it against `priorityRows` when it renders the groups
 * (each chat shown once: attention > pinned > recency). This keeps the response
 * backward-compatible with the already-shipped web that reads only `rows` — a
 * server deploy ahead of the priority-aware client never makes a chat vanish.
 *
 * FIRST-PAGE gating: the two priority groups are computed only when there is no
 * `cursor` and returned empty on `load-more` pages (the client reads them from
 * the first page). This bounds cost — `resolveAgentChatStatuses` over the
 * candidate set runs once per list open, not per scroll page — and is exactly
 * what the additive `rows` above makes safe (later pages need no priority ids to
 * exclude).
 *
 * A recognized pre-PR (legacy) cursor is treated as a first-page request rather
 * than a 400, so a client that held one across the rollout recovers gracefully
 * instead of looping its load-more Retry; a genuinely invalid cursor still 400s.
 */
export async function listMeChats(
  db: Database,
  humanAgentId: string,
  callerMemberId: string,
  organizationId: string,
  query: ListMeChatsQuery,
): Promise<ListMeChatsResponse> {
  const limit = query.limit;
  // Resolve the cursor into a keyset anchor. A recognized `legacy` cursor (a
  // pre-PR shape a client held across the rollout) restarts from page 1 — the
  // client de-duplicates the repeated rows and picks up a fresh v2 cursor — while
  // an `invalid` cursor stays a typed 400 so a genuine client/API bug surfaces
  // instead of being silently masked as a first-page request.
  const decoded = query.cursor ? decodeCursor(query.cursor) : null;
  if (decoded?.status === "invalid") {
    throw new BadRequestError("Invalid cursor");
  }
  const cursor = decoded?.status === "ok" ? decoded : null;

  const filterUnreadOnly = query.filter === "unread";
  const filterWatchingOnly = query.watching === true;
  const engagementPredicate = ENGAGEMENT_VIEW_PREDICATE[query.engagement];
  const originPredicate = query.origin ? originsFilterSql(query.origin) : sql`TRUE`;
  const participantsPredicate = query.with ? participantsFilterSql(query.with) : sql`TRUE`;

  // View-scoped filters shared by every group (ordinary + priority) so the
  // active filter narrows all of them identically.
  const filters = sql`(${!filterUnreadOnly}::bool OR COALESCE(cus.unread_mention_count, 0) > 0)
       AND (${!filterWatchingOnly}::bool OR cm.access_mode = 'watcher')
       AND ${engagementPredicate}
       AND ${originPredicate}
       AND ${participantsPredicate}`;

  // Caller-scoped "mine" set — the non-human agents the caller manages
  // (`agents.manager_id = caller.member_id`, one indexed read via
  // `idx_agents_manager`). Shared across the priority + ordinary enrichment
  // passes and drives the "mine" narrowing on `failed`. The `ne(type, 'human')`
  // guard excludes the caller's own self-managed human agent — defensive today
  // (`resolveAgentChatStatuses` already filters non-human) but belt-and-braces
  // if a future change ever surfaces human statuses. Filtering by `manager_id`
  // alone is sufficient: `members.id` is unique per (user, org), so any agent
  // whose manager is `callerMemberId` is necessarily in the caller's org.
  const managedRows = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.managerId, callerMemberId), ne(agents.type, "human")));
  const managedAgentIds = new Set(managedRows.map((r) => r.uuid));

  const activityOrder = sql`c.activity_at DESC, c.id DESC`;

  // Keyset cursor predicate (sort: activity_at DESC, id DESC). `chats.activity_at`
  // is NOT NULL, so this is a plain keyset with no null-timestamp branch.
  const cursorTsIso = cursor ? cursor.activityAt.toISOString() : null;
  const cursorPredicate = !cursor
    ? sql`TRUE`
    : sql`(c.activity_at < ${cursorTsIso}::timestamptz
           OR (c.activity_at = ${cursorTsIso}::timestamptz AND c.id < ${cursor.chatId}))`;

  // --- Priority groups: FIRST PAGE ONLY -----------------------------------
  // Whole-set projections the client reads once (from the first page). Gating
  // them on `cursor === null` keeps `load-more` cheap AND is what lets `rows`
  // stay ADDITIVE: later pages never exclude priority ids, so the ordinary
  // stream is the complete recency list — backward-compatible with a client that
  // ignores `priorityRows`. See docblock.
  let attention: MeChatRow[] = [];
  let pinned: MeChatRow[] = [];
  if (cursor === null) {
    // Attention candidates — the bounded pre-canonical set the enrichment pass
    // resolves (see `selectAttentionCandidateRows` for the superset rationale).
    const attnCandidateRaw = await selectAttentionCandidateRows(db, {
      humanAgentId,
      organizationId,
      callerMemberId,
      filters,
      orderBy: activityOrder,
    });
    const pinnedRaw = await selectMeChatRawRows(db, {
      humanAgentId,
      organizationId,
      filters,
      extra: sql`cus.pinned_at IS NOT NULL`,
      orderBy: sql`cus.pinned_at DESC, c.id DESC`,
      limit: null,
    });

    // Enrich the priority union once; `failedByChat` splits attention below.
    const priorityRawUnion = dedupeRawByChatId([...attnCandidateRaw, ...pinnedRaw]);
    const { rows: priorityRowsFlat, failedByChat } = await enrichMeChatRows(db, priorityRawUnion, {
      humanAgentId,
      managedAgentIds,
    });
    const priorityRowById = new Map(priorityRowsFlat.map((r) => [r.chatId, r]));

    // Attention = candidates that qualify (failed OR open request), failed-first
    // then activity DESC. Each candidate slice is already activity DESC from the
    // query and `filter` preserves order.
    const attnQualified = attnCandidateRaw.filter((r) => failedByChat.has(r.chat_id) || r.open_request_count > 0);
    attention = [
      ...attnQualified.filter((r) => failedByChat.has(r.chat_id)),
      ...attnQualified.filter((r) => !failedByChat.has(r.chat_id)),
    ]
      .map((r) => priorityRowById.get(r.chat_id))
      .filter((r): r is MeChatRow => r !== undefined);
    const attentionIds = new Set(attention.map((r) => r.chatId));

    // Pinned excludes anything already surfaced in attention (attention wins),
    // preserving the `pinned_at` DESC order.
    pinned = pinnedRaw
      .filter((r) => !attentionIds.has(r.chat_id))
      .map((r) => priorityRowById.get(r.chat_id))
      .filter((r): r is MeChatRow => r !== undefined);
  }

  // --- Ordinary page (EVERY page) -----------------------------------------
  // ADDITIVE: no priority-id exclusion. `rows` is the complete activity-ordered
  // recency stream; a priority chat also appears here and the client
  // de-duplicates it against `priorityRows` when it renders the groups. This
  // keeps the response backward-compatible with the already-shipped web that
  // reads only `rows` (a pinned / open-request / failed chat never vanishes).
  const ordinaryRaw = await selectMeChatRawRows(db, {
    humanAgentId,
    organizationId,
    filters,
    extra: cursorPredicate,
    orderBy: activityOrder,
    limit: limit + 1,
  });

  const hasMore = ordinaryRaw.length > limit;
  const pageRaw = hasMore ? ordinaryRaw.slice(0, limit) : ordinaryRaw;
  const last = pageRaw[pageRaw.length - 1];
  const lastActivity = last ? toChatDate(last.activity_at) : null;
  const nextCursor = hasMore && last && lastActivity ? encodeCursor(lastActivity, last.chat_id) : null;
  const { rows } = await enrichMeChatRows(db, pageRaw, { humanAgentId, managedAgentIds });

  return {
    priorityRows: { attention, pinned },
    rows,
    nextCursor,
  };
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
  const result = await createChat(db, {
    mode: "legacy-empty-web",
    creatorAgentId: humanAgentId,
    organizationId,
    participantAgentIds: distinctIds,
    topic: body.topic ?? null,
  });
  invalidateChatAudience(result.id);
  return { chatId: result.id };
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
