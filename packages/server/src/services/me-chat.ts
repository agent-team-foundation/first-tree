/**
 * Member-facing chat service backing `/me/chats*` endpoints (chat-first
 * workspace).
 *
 * Responsibilities:
 *   - Cursor-paginated conversation list across participant + watcher rows
 *     for the caller's human agent.
 *   - Create a new chat (no dedupe, runs `recomputeChatWatchers` after).
 *   - Add participants (idempotent, runs `recomputeChatWatchers` after).
 *   - Mark-read (touches whichever of the two tables holds the user's row).
 *   - Join → state-carry watcher → speaker (delegates to `watcher.ts`).
 *   - Leave → state-carry speaker → watcher (delegates to `watcher.ts`).
 *
 * See docs/chat-first-workspace-product-design.md "API Contract" + "Data
 * Model".
 */

import { randomUUID } from "node:crypto";
import type {
  AddMeChatParticipants,
  CreateMeChat,
  ListMeChatsQuery,
  ListMeChatsResponse,
  MeChatLeaveResponse,
  MeChatReadResponse,
  MeChatRow,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chatSubscriptions, chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, NotFoundError } from "../errors.js";
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
// List
// ---------------------------------------------------------------------------

/**
 * GET /me/chats — cursor-paginated conversation list.
 *
 * SQL strategy:
 *   - One query that UNIONs participant rows and subscription rows for the
 *     caller's human agent, joined to chats. The UNION+coalesce keeps both
 *     `unread_mention_count` and `membership_kind` per row.
 *   - Filter `parent_chat_id IS NULL` (threads are excluded in v1).
 *   - Sort `(last_message_at DESC NULLS LAST, chat_id DESC)`.
 *   - Cursor narrows the result to rows STRICTLY before `(cursor.ts, cursor.id)`.
 *   - Followed by a small participant-list lookup for the page only.
 */
export async function listMeChats(
  db: Database,
  humanAgentId: string,
  query: ListMeChatsQuery,
): Promise<ListMeChatsResponse> {
  const limit = query.limit;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) {
    throw new BadRequestError("Invalid cursor");
  }

  // The UNION keeps both rows distinguishable via membership_kind. We fetch
  // limit+1 to know whether to emit a nextCursor.
  // NOTE: when this user is somehow a watcher AND a participant (should be
  // impossible per design invariant 1), the participant row wins via DISTINCT
  // ON.
  const filterUnreadOnly = query.filter === "unread";
  const filterWatchingOnly = query.filter === "watching";

  // Cursor predicate (sort: last_message_at DESC NULLS LAST, chat_id DESC).
  // The cursor identifies one row; we want every row STRICTLY AFTER it in
  // that ordering. Three cases:
  //
  //   1. No cursor → first page, no predicate (TRUE).
  //   2. Cursor's lastMessageAt is null → we're already in the NULL tail.
  //      Only NULL-timestamped rows with smaller chat_id can come after.
  //   3. Cursor's lastMessageAt is non-null → rows with strictly-smaller
  //      timestamp, OR same-timestamp + smaller chat_id, OR any
  //      NULL-timestamped row (NULLS LAST puts them after every non-null).
  //
  // Splitting these into a single `OR` with NULL inputs is hostile to
  // PostgreSQL's planner and was previously buggy (NULL `<` non-null is
  // NULL, not false, but NULL `<` NULL is also NULL — so naive `<` filter
  // dropped NULL rows on case 3).
  // postgres-js can't serialize a JS Date when it's bound through a raw
  // `sql` template (no column-type metadata) — the typed builders normally
  // do this for us. Pre-stringify to ISO so the param goes through as text
  // and the `::timestamptz` cast in SQL handles the rest.
  const cursorTsIso = cursor?.lastMessageAt ? cursor.lastMessageAt.toISOString() : null;
  const cursorPredicate = !cursor
    ? sql`TRUE`
    : cursor.lastMessageAt === null
      ? sql`(c.last_message_at IS NULL AND c.id < ${cursor.chatId})`
      : sql`(c.last_message_at IS NULL
             OR c.last_message_at < ${cursorTsIso}::timestamptz
             OR (c.last_message_at = ${cursorTsIso}::timestamptz AND c.id < ${cursor.chatId}))`;

  // postgres-js returns timestamptz as ISO strings when bound through a raw
  // `sql\`...\`` template (no column-type metadata), unlike drizzle's typed
  // select which would parse to Date. We accept either shape and coerce
  // below so the response uses ISO strings consistently.
  const rawRows = (await db.execute(sql`
    WITH membership AS (
      SELECT chat_id, 'participant'::text AS membership_kind, unread_mention_count
        FROM chat_participants
       WHERE agent_id = ${humanAgentId}
      UNION ALL
      SELECT chat_id, 'watching'::text   AS membership_kind, unread_mention_count
        FROM chat_subscriptions
       WHERE agent_id = ${humanAgentId}
    ),
    /* Resolve duplicates (should not happen post-invariant-1, but cheap) by
       preferring the participant row. */
    deduped AS (
      SELECT DISTINCT ON (chat_id)
        chat_id, membership_kind, unread_mention_count
        FROM membership
        ORDER BY chat_id, CASE WHEN membership_kind = 'participant' THEN 0 ELSE 1 END
    )
    SELECT
      c.id                  AS chat_id,
      c.type                AS type,
      c.topic               AS topic,
      c.parent_chat_id      AS parent_chat_id,
      c.last_message_at     AS last_message_at,
      c.last_message_preview AS last_message_preview,
      (SELECT count(*) FROM chat_participants WHERE chat_id = c.id) AS participant_count,
      d.membership_kind     AS membership_kind,
      d.unread_mention_count AS unread_mention_count
      FROM chats c
      JOIN deduped d ON d.chat_id = c.id
     WHERE c.parent_chat_id IS NULL
       /* Filter: unread / watching */
       AND (${!filterUnreadOnly}::bool OR d.unread_mention_count > 0)
       AND (${!filterWatchingOnly}::bool OR d.membership_kind = 'watching')
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
    membership_kind: "participant" | "watching";
    unread_mention_count: number;
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

  // Lookup participants for the page (single query). Includes display_name +
  // type so the row can render an inline summary.
  const participantRows = await db
    .select({
      chatId: chatParticipants.chatId,
      agentId: chatParticipants.agentId,
      displayName: agents.displayName,
      type: agents.type,
    })
    .from(chatParticipants)
    .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
    .where(inArray(chatParticipants.chatId, chatIds));

  const participantsByChat = new Map<string, MeChatRow["participants"]>();
  for (const p of participantRows) {
    const list = participantsByChat.get(p.chatId) ?? [];
    list.push({ agentId: p.agentId, displayName: p.displayName, type: p.type });
    participantsByChat.set(p.chatId, list);
  }

  // First-message lookup for the page — drives the auto-title fallback in
  // `resolveChatTitle` so chats without a manual `topic` get a meaningful
  // identity (`"请帮我重构这个文件"` rather than just the participant join,
  // which often duplicates the chip row). Mirrors `session.ts:listAgentSessions`'s
  // `selectDistinctOn` pattern over `idx_messages_chat_time`. Read-time
  // (vs a denormalized projection column) so editing/deleting the first
  // message naturally flows into the title without a separate write path.
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
    return {
      chatId: r.chat_id,
      type: r.type,
      membershipKind: r.membership_kind,
      title,
      topic: r.topic,
      participants,
      participantCount: Number(r.participant_count),
      lastMessageAt: toDate(r.last_message_at)?.toISOString() ?? null,
      lastMessagePreview: r.last_message_preview,
      unreadMentionCount: r.unread_mention_count,
      canReply: r.membership_kind === "participant",
      taskId: null,
      taskStatus: null,
    };
  });

  return { rows, nextCursor };
}

/**
 * Title resolution priority:
 *
 *   1. `chat.topic` (manual, set via `PATCH /admin/chats/:id`)
 *   2. First message summary (auto, ≤ 50 chars from `extractSummary`)
 *   3. Participant join (fallback when chat has no messages yet)
 *
 * The first-message fallback is the chat-first equivalent of how
 * ChatGPT / Claude.ai name conversations from the user's opening
 * prompt — gives same-agent multi-chats distinct identities and
 * removes the "title duplicates participants chip row" anti-pattern.
 */
export function resolveChatTitle(
  topic: string | null,
  firstMessageSummary: string | null,
  participants: MeChatRow["participants"],
  selfAgentId: string,
): string {
  if (topic && topic.length > 0) return topic;
  if (firstMessageSummary && firstMessageSummary.length > 0) return firstMessageSummary;
  const others = participants.filter((p) => p.agentId !== selfAgentId);
  if (others.length === 0) return "(no participants)";
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

  // Verify all participants exist and are in the same org as the user.
  const allIds = [humanAgentId, ...distinctIds];
  const found = await db
    .select({ uuid: agents.uuid, organizationId: agents.organizationId, type: agents.type })
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

  const chatType = distinctIds.length === 1 ? "direct" : "group";

  // "Agent-only direct" rule: when both ends of a direct chat are non-human,
  // every message would otherwise wake the other party in `full` mode and
  // cause a reply loop. Mirror the same rule used by services/chat.ts.
  const isDirectAgentOnly = chatType === "direct" && found.every((a) => a.type !== "human");

  const chatId = randomUUID();
  const topic = body.topic ?? null;

  await db.transaction(async (tx) => {
    await tx.insert(chats).values({
      id: chatId,
      organizationId,
      type: chatType,
      topic,
    });

    await tx.insert(chatParticipants).values(
      allIds.map((agentId) => ({
        chatId,
        agentId,
        role: agentId === humanAgentId ? ("owner" as const) : ("member" as const),
        ...(isDirectAgentOnly ? { mode: "mention_only" as const } : {}),
      })),
    );

    // Add watchers for managers of any non-human participant. Idempotent.
    await recomputeChatWatchers(tx, chatId);
  });

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

  // Caller-side authorisation. We return 404 (not 403) for "cannot see this
  // chat" so a non-participant cannot probe chat existence by uuid. The two
  // gates:
  //   1. the chat lives in the caller's currently-active organisation, AND
  //   2. the caller is a speaking participant of the chat.
  // Watcher-only callers MUST `join` first — adding speakers is a speaker
  // privilege. (Watchers can't speak, so it would be weird for them to invite
  // others to speak.)
  if (chat.organizationId !== callerOrganizationId) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  const [callerRow] = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, callerHumanAgentId)))
    .limit(1);
  if (!callerRow) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }

  const found = await db
    .select({ uuid: agents.uuid, organizationId: agents.organizationId, type: agents.type })
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

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ agentId: chatParticipants.agentId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    const existingSet = new Set(existing.map((e) => e.agentId));
    const toInsert = distinct.filter((id) => !existingSet.has(id));
    if (toInsert.length === 0) {
      // Idempotent — nothing to do, but still recompute watchers in case the
      // caller is fixing a stale watcher set.
      await recomputeChatWatchers(tx, chatId);
      return;
    }

    // Direct → group upgrade: 3+ speakers triggers it. We mirror the rule
    // here (and not via services/chat.ts) so we can write the upgrade and
    // the inserts in the same tx without a circular import.
    if (existing.length + toInsert.length >= 3 && chat.type === "direct") {
      await tx.update(chats).set({ type: "group", updatedAt: new Date() }).where(eq(chats.id, chatId));
      const nonHumans = await tx
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(
          and(
            inArray(
              agents.uuid,
              existing.map((e) => e.agentId),
            ),
            sql`${agents.type} <> 'human'`,
          ),
        );
      const nonHumanIds = nonHumans.map((a) => a.uuid);
      if (nonHumanIds.length > 0) {
        await tx
          .update(chatParticipants)
          .set({ mode: "mention_only" })
          .where(and(eq(chatParticipants.chatId, chatId), inArray(chatParticipants.agentId, nonHumanIds)));
      }
    }

    await tx
      .insert(chatParticipants)
      .values(toInsert.map((agentId) => ({ chatId, agentId, role: "member" as const, mode: "full" as const })))
      .onConflictDoNothing();

    // Drop watcher rows for any of the new speakers (mutual exclusion).
    await tx
      .delete(chatSubscriptions)
      .where(and(eq(chatSubscriptions.chatId, chatId), inArray(chatSubscriptions.agentId, toInsert)));

    await recomputeChatWatchers(tx, chatId);
  });
}

// ---------------------------------------------------------------------------
// Mark read
// ---------------------------------------------------------------------------

export async function markMeChatRead(db: Database, chatId: string, humanAgentId: string): Promise<MeChatReadResponse> {
  const now = new Date();
  // One UPDATE per table; both are idempotent. The "either or both rows
  // exist" case is fine — the design invariant says exactly one of the two
  // exists for any (chat, user) pair, but the writes are safe even if a
  // race ever inserted both.
  await db
    .update(chatParticipants)
    .set({ lastReadAt: now, unreadMentionCount: 0 })
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, humanAgentId)));

  await db
    .update(chatSubscriptions)
    .set({ lastReadAt: now, unreadMentionCount: 0 })
    .where(and(eq(chatSubscriptions.chatId, chatId), eq(chatSubscriptions.agentId, humanAgentId)));

  return { chatId, lastReadAt: now.toISOString(), unreadMentionCount: 0 };
}

// ---------------------------------------------------------------------------
// Join / Leave
// ---------------------------------------------------------------------------

export async function joinMeChat(db: Database, chatId: string, humanAgentId: string): Promise<void> {
  const membership = await resolveChatMembership(db, chatId, humanAgentId);
  ensureCanJoin(membership);
  await joinAsParticipant(db, chatId, humanAgentId);
}

export async function leaveMeChat(db: Database, chatId: string, humanAgentId: string): Promise<MeChatLeaveResponse> {
  const result = await leaveAsParticipant(db, chatId, humanAgentId);
  return result;
}

// ---------------------------------------------------------------------------
// "Total unread chats" — small helper for the conversation list badge
// ---------------------------------------------------------------------------

/**
 * Used by future bell-badge / list-pill counts. Cheap aggregate query so
 * the web client never has to scan the page rows itself.
 */
export async function countUnreadMeChats(db: Database, humanAgentId: string): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (
      SELECT chat_id FROM chat_participants
       WHERE agent_id = ${humanAgentId} AND unread_mention_count > 0
      UNION
      SELECT chat_id FROM chat_subscriptions
       WHERE agent_id = ${humanAgentId} AND unread_mention_count > 0
    ) sub
  `);
  return rows[0]?.count ?? 0;
}
