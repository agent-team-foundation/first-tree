import { MENTION_REGEX, type SessionState, stripCode } from "@first-tree/shared";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { Notifier } from "./notifier.js";

export const SUMMARY_MAX_LENGTH = 50;

/** Extract a plain-text summary from a message's JSONB content field.
 *  Used as the auto-title fallback in chat list rendering — see
 *  `me-chat.ts:resolveChatTitle` and `admin/chats.ts:getChat`.
 *
 *  - `@<name>` mention tokens are stripped before truncation: in the
 *    chat-first model they're routing/audience metadata, not part of
 *    the user's intent. Leaving them in produces noisy titles like
 *    "@agent-01 帮我重构这个文件" or "你好 @agent-02 看看".
 *  - Whitespace runs (including those left behind by mention removal)
 *    collapse to single spaces.
 *  - If the cleaned text is empty (e.g., a message that's only
 *    `@agent-01`), returns null so the caller falls through to
 *    the participant-join fallback.
 *  - Slicing is code-point-aware (`Array.from + join`) so emoji /
 *    surrogate pairs aren't split into garbled half-characters. */
export function extractSummary(content: unknown, maxLen = SUMMARY_MAX_LENGTH): string | null {
  let text = "";
  if (typeof content === "object" && content !== null && "text" in content) {
    text = String((content as { text: unknown }).text ?? "");
  } else if (typeof content === "string") {
    text = content;
  }
  if (!text) return null;
  // `stripCode` first so identifier-shaped tokens inside Markdown
  // code regions (`` `@param` ``, fenced blocks) aren't misclassified
  // as mentions and stripped — that would produce titles like
  // `"Use  decorator"` from `"Use \`@param\` decorator"`. Mirrors
  // `extractMentions`'s pipeline so routing and titling agree on what
  // counts as a real mention vs a code reference.
  const cleaned = stripCode(text).replace(MENTION_REGEX, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maxLen).join("");
}

export type SessionListItem = {
  agentId: string;
  chatId: string;
  state: string;
  /**
   * Agent-global `agent_presence.runtime_state` copied onto every session
   * row for the same agent. NOT a per-session axis. Retained because admin
   * / roster views consume the aggregate; for per-(agent, chat) signals
   * read `state` (lifecycle) or `MeChatRow.liveActivity` (live working).
   *
   * @deprecated for per-session UI.
   */
  runtimeState: string | null;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  summary: string | null;
  topic: string | null;
};

export type OrgSessionListViewer = {
  role: "admin" | "member";
  memberId: string;
  humanAgentId: string;
};

function chatAccessPredicate(viewer: OrgSessionListViewer) {
  return sql`(
    EXISTS (
      SELECT 1
      FROM chat_membership direct_cm
      WHERE direct_cm.chat_id = ${chats.id}
        AND direct_cm.agent_id = ${viewer.humanAgentId}
    )
    OR EXISTS (
      SELECT 1
      FROM chat_membership managed_cm
      INNER JOIN agents managed_agent ON managed_agent.uuid = managed_cm.agent_id
      WHERE managed_cm.chat_id = ${chats.id}
        AND managed_cm.access_mode = 'speaker'
        AND managed_agent.manager_id = ${viewer.memberId}
    )
  )`;
}

async function accessibleChatIdSet(
  db: Database,
  viewer: OrgSessionListViewer,
  chatIds: string[],
): Promise<Set<string>> {
  const accessible = new Set<string>();
  if (chatIds.length === 0) return accessible;

  const directRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.agentId, viewer.humanAgentId)));
  for (const row of directRows) accessible.add(row.chatId);

  const supervisedRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(
      and(
        inArray(chatMembership.chatId, chatIds),
        eq(chatMembership.accessMode, "speaker"),
        eq(agents.managerId, viewer.memberId),
      ),
    );
  for (const row of supervisedRows) accessible.add(row.chatId);

  return accessible;
}

/** List sessions for a specific agent, with optional state filters. */
export async function listAgentSessions(
  db: Database,
  agentId: string,
  filters?: { state?: string; runtimeState?: string },
): Promise<SessionListItem[]> {
  const conditions = [eq(agentChatSessions.agentId, agentId)];
  if (filters?.state) {
    conditions.push(eq(agentChatSessions.state, filters.state));
  } else {
    // Default: hide archived (evicted) rows from listings.
    conditions.push(ne(agentChatSessions.state, "evicted"));
  }

  const rows = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      updatedAt: agentChatSessions.updatedAt,
      chatCreatedAt: chats.createdAt,
      chatTopic: chats.topic,
    })
    .from(agentChatSessions)
    .innerJoin(chats, eq(agentChatSessions.chatId, chats.id))
    .where(and(...conditions))
    .orderBy(desc(agentChatSessions.updatedAt));

  // Get the agent's runtimeState once (it's agent-level, not per-session)
  const [presence] = await db
    .select({ runtimeState: agentPresence.runtimeState })
    .from(agentPresence)
    .where(eq(agentPresence.agentId, agentId))
    .limit(1);

  const agentRuntimeState = presence?.runtimeState ?? null;

  // Filter by runtimeState if requested (agent-level filter)
  if (filters?.runtimeState && agentRuntimeState !== filters.runtimeState) {
    return [];
  }

  // Get message counts per chat in a single query
  const chatIds = rows.map((r) => r.chatId);
  const messageCounts =
    chatIds.length > 0
      ? await db
          .select({
            chatId: inboxEntries.chatId,
            count: sql<number>`count(*)::int`,
          })
          .from(inboxEntries)
          .where(
            and(
              eq(inboxEntries.inboxId, sql`(SELECT inbox_id FROM agents WHERE uuid = ${agentId})`),
              inArray(inboxEntries.chatId, chatIds),
            ),
          )
          .groupBy(inboxEntries.chatId)
      : [];

  const countMap = new Map(messageCounts.map((r) => [r.chatId, r.count]));

  // Get first message content per chat for summary
  const firstMessages =
    chatIds.length > 0
      ? await db
          .selectDistinctOn([messages.chatId], { chatId: messages.chatId, content: messages.content })
          .from(messages)
          .where(inArray(messages.chatId, chatIds))
          .orderBy(messages.chatId, messages.createdAt)
      : [];

  const summaryMap = new Map<string, string>();
  for (const row of firstMessages) {
    const summary = extractSummary(row.content);
    if (summary) {
      summaryMap.set(row.chatId, summary);
    }
  }

  return rows.map((r) => ({
    agentId: r.agentId,
    chatId: r.chatId,
    state: r.state,
    runtimeState: agentRuntimeState,
    startedAt: r.chatCreatedAt.toISOString(),
    lastActivityAt: r.updatedAt.toISOString(),
    messageCount: countMap.get(r.chatId) ?? 0,
    summary: summaryMap.get(r.chatId) ?? null,
    topic: r.chatTopic ?? null,
  }));
}

/** Get a single session's detail. */
export async function getSession(db: Database, agentId: string, chatId: string): Promise<SessionListItem> {
  const [row] = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      updatedAt: agentChatSessions.updatedAt,
      chatCreatedAt: chats.createdAt,
      chatTopic: chats.topic,
    })
    .from(agentChatSessions)
    .innerJoin(chats, eq(agentChatSessions.chatId, chats.id))
    .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
    .limit(1);

  if (!row) throw new NotFoundError(`Session (${agentId}, ${chatId}) not found`);

  const [presence] = await db
    .select({ runtimeState: agentPresence.runtimeState })
    .from(agentPresence)
    .where(eq(agentPresence.agentId, agentId))
    .limit(1);

  // Count inbox entries for this session
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inboxEntries)
    .where(
      and(
        eq(inboxEntries.inboxId, sql`(SELECT inbox_id FROM agents WHERE uuid = ${agentId})`),
        eq(inboxEntries.chatId, chatId),
      ),
    );

  // Get first message for summary
  const firstMsgRows = await db.execute<{ content: unknown }>(
    sql`SELECT content FROM messages WHERE chat_id = ${chatId} ORDER BY created_at ASC LIMIT 1`,
  );
  const firstMsg = firstMsgRows[0];
  const summary = firstMsg ? extractSummary(firstMsg.content) : null;

  return {
    agentId: row.agentId,
    chatId: row.chatId,
    state: row.state,
    runtimeState: presence?.runtimeState ?? null,
    startedAt: row.chatCreatedAt.toISOString(),
    lastActivityAt: row.updatedAt.toISOString(),
    messageCount: countRow?.count ?? 0,
    summary,
    topic: row.chatTopic ?? null,
  };
}

/**
 * List all sessions across all agents in one organization, with pagination.
 *
 * `organizationId` is a required positional parameter, not an optional
 * filter: it is the tenant boundary, and an omitted boundary must be a
 * compile error rather than a silently unscoped query.
 */
export async function listAllSessions(
  db: Database,
  organizationId: string,
  viewer: OrgSessionListViewer,
  limit: number,
  cursor?: string,
  filters?: { state?: string; agentId?: string },
): Promise<{ items: SessionListItem[]; nextCursor: string | null }> {
  // The boundary applies to BOTH tenant-owned tables this query exposes:
  // agent_chat_sessions has independent FKs to agents and chats with no DB
  // constraint tying their orgs together, so a stale or malicious client
  // reporting session:state for a foreign chatId could otherwise leak that
  // chat's topic/summary through the unconstrained chats join.
  const conditions = [eq(agents.organizationId, organizationId), eq(chats.organizationId, organizationId)];
  if (viewer.role !== "admin") {
    conditions.push(chatAccessPredicate(viewer));
  }
  if (filters?.state) {
    conditions.push(eq(agentChatSessions.state, filters.state));
  } else {
    // Default: hide archived (evicted) rows from listings.
    conditions.push(ne(agentChatSessions.state, "evicted"));
  }
  if (filters?.agentId) {
    conditions.push(eq(agentChatSessions.agentId, filters.agentId));
  }
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (Number.isNaN(cursorDate.getTime())) {
      // An Invalid Date would otherwise reach Postgres as a malformed
      // timestamp parameter and surface as a 500.
      throw new BadRequestError(`Invalid cursor: ${cursor}`);
    }
    // `lt()` (not a raw sql`` fragment) so the Date goes through the
    // column's driver mapping — postgres-js rejects raw Date parameters.
    conditions.push(lt(agentChatSessions.updatedAt, cursorDate));
  }

  const rows = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      updatedAt: agentChatSessions.updatedAt,
      chatCreatedAt: chats.createdAt,
      chatTopic: chats.topic,
    })
    .from(agentChatSessions)
    .innerJoin(chats, eq(agentChatSessions.chatId, chats.id))
    .innerJoin(agents, eq(agentChatSessions.agentId, agents.uuid))
    .where(and(...conditions))
    .orderBy(desc(agentChatSessions.updatedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  // Batch-fetch runtimeState for all unique agents
  const agentIds = [...new Set(items.map((r) => r.agentId))];
  const presenceRows =
    agentIds.length > 0
      ? await db
          .select({ agentId: agentPresence.agentId, runtimeState: agentPresence.runtimeState })
          .from(agentPresence)
          .where(inArray(agentPresence.agentId, agentIds))
      : [];
  const runtimeMap = new Map(presenceRows.map((r) => [r.agentId, r.runtimeState]));

  // Batch-fetch first message per chat for summary (parity with listAgentSessions)
  const chatIds = [...new Set(items.map((r) => r.chatId))];
  const accessibleChatIds = await accessibleChatIdSet(db, viewer, chatIds);
  const visibleSummaryChatIds = chatIds.filter((chatId) => accessibleChatIds.has(chatId));
  const firstMessages =
    visibleSummaryChatIds.length > 0
      ? await db
          .selectDistinctOn([messages.chatId], { chatId: messages.chatId, content: messages.content })
          .from(messages)
          .where(inArray(messages.chatId, visibleSummaryChatIds))
          .orderBy(messages.chatId, messages.createdAt)
      : [];
  const summaryMap = new Map<string, string>();
  for (const row of firstMessages) {
    const summary = extractSummary(row.content);
    if (summary) summaryMap.set(row.chatId, summary);
  }

  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.updatedAt.toISOString() : null;

  return {
    items: items.map((r) => {
      const canSeeChat = accessibleChatIds.has(r.chatId);
      return {
        agentId: r.agentId,
        chatId: r.chatId,
        state: r.state,
        runtimeState: runtimeMap.get(r.agentId) ?? null,
        startedAt: r.chatCreatedAt.toISOString(),
        lastActivityAt: r.updatedAt.toISOString(),
        messageCount: 0, // Omit per-session message count in global list for performance
        summary: canSeeChat ? (summaryMap.get(r.chatId) ?? null) : null,
        topic: canSeeChat ? (r.chatTopic ?? null) : null,
      };
    }),
    nextCursor,
  };
}

export type StateTransitionResult = {
  state: SessionState;
  transitioned: boolean;
};

/** Commit `active → suspended`. No-op on suspended/evicted. Throws if row is missing. */
export async function suspendSession(
  db: Database,
  agentId: string,
  chatId: string,
  organizationId: string,
  notifier?: Notifier,
): Promise<StateTransitionResult> {
  return transitionSessionState(db, agentId, chatId, "suspended", ["active"], organizationId, notifier);
}

/** Commit `suspended → evicted` (terminal — listings hide it, revival defense blocks resurrection). */
export async function archiveSession(
  db: Database,
  agentId: string,
  chatId: string,
  organizationId: string,
  notifier?: Notifier,
): Promise<StateTransitionResult> {
  return transitionSessionState(db, agentId, chatId, "evicted", ["suspended"], organizationId, notifier);
}

export type ArchiveAgentSessionsResult = {
  chatIds: string[];
  transitioned: number;
};

/**
 * Terminally evict every non-evicted session for an agent. Runtime switches use
 * this after the agent has moved to a new client/runtime so stale local session
 * state from the old handler cannot be resumed under the new provider.
 */
export async function archiveAllSessionsForAgent(
  db: Database,
  agentId: string,
  organizationId: string,
  notifier?: Notifier,
  options: { runtimeSwitchClaimId?: string } = {},
): Promise<ArchiveAgentSessionsResult> {
  const now = new Date();
  const rows = await db.transaction(async (tx) => {
    if (options.runtimeSwitchClaimId) {
      const [claim] = await tx
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(
          and(
            eq(agents.uuid, agentId),
            sql`${agents.metadata}->'runtimeSwitch'->>'claimId' = ${options.runtimeSwitchClaimId}`,
            sql`${agents.metadata}->'runtimeSwitch'->>'phase' = 'committed'`,
          ),
        )
        .for("update")
        .limit(1);
      if (!claim) {
        throw new ConflictError("Runtime switch claim is no longer committed for session archive");
      }
    }

    const transitioned = await tx
      .update(agentChatSessions)
      .set({ state: "evicted", runtimeState: "idle", runtimeStateAt: now, updatedAt: now })
      .where(and(eq(agentChatSessions.agentId, agentId), ne(agentChatSessions.state, "evicted")))
      .returning({ chatId: agentChatSessions.chatId });

    await tx.delete(sessionEvents).where(eq(sessionEvents.agentId, agentId));

    await tx
      .update(agentPresence)
      .set({
        activeSessions: 0,
        totalSessions: 0,
        runtimeState: "idle",
        runtimeUpdatedAt: now,
        lastSeenAt: now,
      })
      .where(eq(agentPresence.agentId, agentId));

    return transitioned;
  });

  if (notifier) {
    for (const row of rows) {
      notifier.notifySessionStateChange(agentId, row.chatId, "evicted", organizationId).catch(() => {});
    }
  }

  return { chatIds: rows.map((row) => row.chatId), transitioned: rows.length };
}

async function transitionSessionState(
  db: Database,
  agentId: string,
  chatId: string,
  target: SessionState,
  from: SessionState[],
  organizationId: string,
  notifier: Notifier | undefined,
): Promise<StateTransitionResult> {
  const now = new Date();
  let finalState: SessionState | null = null;
  let transitioned = false;

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .for("update");

    if (!existing) return;
    const current = existing.state as SessionState;
    finalState = current;

    if (!from.includes(current)) return;

    await tx
      .update(agentChatSessions)
      .set({ state: target, updatedAt: now })
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)));

    const [counts] = await tx
      .select({
        active: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} = 'active')::int`,
        total: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} != 'evicted')::int`,
      })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.agentId, agentId));

    await tx
      .update(agentPresence)
      .set({
        activeSessions: counts?.active ?? 0,
        totalSessions: counts?.total ?? 0,
        lastSeenAt: now,
      })
      .where(eq(agentPresence.agentId, agentId));

    finalState = target;
    transitioned = true;
  });

  if (finalState === null) {
    throw new NotFoundError(`Session (${agentId}, ${chatId}) not found`);
  }

  if (transitioned && notifier) {
    notifier.notifySessionStateChange(agentId, chatId, target, organizationId).catch(() => {});
  }

  return { state: finalState, transitioned };
}

/**
 * Filter sessions to only those where the given agent is also a participant in the chat.
 * Used when a non-manager views sessions of an org-visible agent — they should only see
 * sessions for chats they participate in.
 */
export async function filterSessionsByParticipant(
  db: Database,
  sessions: SessionListItem[],
  participantAgentId: string,
): Promise<SessionListItem[]> {
  if (sessions.length === 0) return [];

  const chatIds = sessions.map((s) => s.chatId);
  const participantRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(
      and(
        inArray(chatMembership.chatId, chatIds),
        eq(chatMembership.agentId, participantAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    );

  const allowedChatIds = new Set(participantRows.map((r) => r.chatId));
  return sessions.filter((s) => allowedChatIds.has(s.chatId));
}
