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
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { addChatParticipants, changeChatType } from "./participant-mode.js";
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
 *   - Single-stream query: `chats JOIN chat_membership LEFT JOIN
 *     chat_user_state`. The membership row carries access_mode
 *     (speaker → "participant" / watcher → "watching"); the user
 *     state row supplies the unread counter (COALESCE → 0 when
 *     row is missing).
 *   - Filter `parent_chat_id IS NULL` (threads excluded in v1).
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
  const filterWatchingOnly = query.filter === "watching";

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
      COALESCE(cus.unread_mention_count, 0) AS unread_mention_count
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
  // the conversation row's participant chip list).
  const participantRows = await db
    .select({
      chatId: chatMembership.chatId,
      agentId: chatMembership.agentId,
      displayName: agents.displayName,
      type: agents.type,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.accessMode, "speaker")));

  const participantsByChat = new Map<string, MeChatRow["participants"]>();
  for (const p of participantRows) {
    const list = participantsByChat.get(p.chatId) ?? [];
    list.push({ agentId: p.agentId, displayName: p.displayName, type: p.type });
    participantsByChat.set(p.chatId, list);
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
    return {
      chatId: r.chat_id,
      type: r.type,
      membershipKind: isSpeaker ? "participant" : "watching",
      title,
      topic: r.topic,
      participants,
      participantCount: Number(r.participant_count),
      lastMessageAt: toDate(r.last_message_at)?.toISOString() ?? null,
      lastMessagePreview: r.last_message_preview,
      unreadMentionCount: r.unread_mention_count,
      canReply: isSpeaker,
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
export function resolveChatTitle(
  topic: string | null,
  firstMessageSummary: string | null,
  participants: MeChatRow["participants"],
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

  const chatId = randomUUID();
  const topic = body.topic ?? null;

  await db.transaction(async (tx) => {
    await tx.insert(chats).values({
      id: chatId,
      organizationId,
      type: chatType,
      topic,
    });

    // Mode derived per-row from `(chats.type, agents.type)` via the
    // canonical entrypoint — pre-fix `createMeChat` wrote
    // `mode: 'mention_only'` only on the direct-agent-only branch and
    // defaulted everything else to `'full'`, which silently left
    // `(type='group', non-human)` participants in `'full'` mode (the
    // root-cause group-chat bug from §1.1 of the Phase 1 design doc).
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
  const [callerRow] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
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

    // Direct → group upgrade: 3+ speakers triggers it. Delegate the type
    // flip + re-grading of existing non-human speakers to `changeChatType`
    // so the rule lives in one place (`services/participant-mode.ts`).
    const isUpgradingToGroup = existingSpeakers.length + toUpsert.length >= 3 && chat.type === "direct";
    if (isUpgradingToGroup) {
      await changeChatType(tx, chatId, "group");
    }

    // Mode derived per-row from `(chats.type, agents.type)` by the canonical
    // entrypoint. `addChatParticipants` re-reads `chats.type` so it picks
    // up the post-`changeChatType` value above; we don't have to pass an
    // `isGroupAfter` flag around. `upgradeWatcherToSpeaker: true` promotes
    // any pre-existing watcher row in place — chat_user_state lives in a
    // separate table so the user's read state survives the promotion
    // untouched (no state-carry transaction needed).
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
 * Used by future bell-badge / list-pill counts. Single-table count
 * over `chat_user_state` — much cheaper than the legacy UNION because
 * the partial index `idx_user_state_unread` bounds the scan by the
 * unread row count alone.
 */
export async function countUnreadMeChats(db: Database, humanAgentId: string): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM chat_user_state
     WHERE agent_id = ${humanAgentId} AND unread_mention_count > 0
  `);
  return rows[0]?.count ?? 0;
}
