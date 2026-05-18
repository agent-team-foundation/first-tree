import type {
  ContextTreeUsageEvent,
  ContextTreeUsageSummary,
  SessionEvent,
  SessionEventKind,
} from "@agent-team-foundation/first-tree-hub-shared";
import { sessionEventSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { maybeBindGithubEntityFromToolCall } from "./github-entity-chat.js";

const log = createLogger("SessionEvent");

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_SEQ_RETRIES = 3;

export type SessionEventRow = {
  id: string;
  agentId: string;
  chatId: string;
  seq: number;
  kind: SessionEventKind;
  payload: SessionEvent["payload"];
  createdAt: string;
};

function rowToEvent(row: {
  id: string;
  agentId: string;
  chatId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: Date;
}): SessionEventRow {
  return {
    id: row.id,
    agentId: row.agentId,
    chatId: row.chatId,
    seq: row.seq,
    kind: row.kind as SessionEventKind,
    payload: row.payload as SessionEvent["payload"],
    createdAt: row.createdAt.toISOString(),
  };
}

/** Append one event; throws after MAX_SEQ_RETRIES on persistent seq contention. */
export async function appendEvent(
  db: Database,
  agentId: string,
  chatId: string,
  event: SessionEvent,
): Promise<SessionEventRow> {
  const validated = sessionEventSchema.parse(event);

  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
    const id = uuidv7();
    const payloadJson = JSON.stringify(validated.payload);
    const result = await db.execute<{
      id: string;
      agent_id: string;
      chat_id: string;
      seq: number;
      kind: string;
      payload: unknown;
      created_at: Date;
    }>(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload)
      SELECT ${id}, ${agentId}, ${chatId},
             COALESCE(MAX(seq), 0) + 1, ${validated.kind}, ${payloadJson}::jsonb
        FROM session_events
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
      ON CONFLICT (agent_id, chat_id, seq) DO NOTHING
      RETURNING id, agent_id, chat_id, seq, kind, payload, created_at
    `);

    const row = result[0];
    if (row) {
      const persisted = rowToEvent({
        id: row.id,
        agentId: row.agent_id,
        chatId: row.chat_id,
        seq: row.seq,
        kind: row.kind,
        payload: row.payload,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      });

      // Side-effect: when a tool_call event reports the agent just created a
      // GitHub PR/Issue, write the chat ↔ entity mapping eagerly so the
      // incoming `*.opened` webhook routes back to this chat instead of
      // forking a fresh one. Fire-and-forget — the main session-event write
      // has already succeeded and must not be unwound on bookkeeping
      // failures. Status filter avoids spurious DB queries: only `ok` events
      // carry a stdout preview worth extracting from.
      if (validated.kind === "tool_call" && validated.payload.status === "ok") {
        maybeBindGithubEntityFromToolCall(db, agentId, chatId, validated.payload).catch((err) => {
          log.warn({ err, agentId, chatId }, "agent_binding side-effect failed");
        });
      }

      return persisted;
    }
  }

  throw new Error(`session_events seq contention on ${agentId}/${chatId}`);
}

/**
 * List events for a session with cursor pagination.
 *
 * - `direction: "asc"` (default) walks oldest → newest; cursor is the last
 *   seq seen on the previous page (next page starts at seq > cursor).
 * - `direction: "desc"` walks newest → oldest; cursor is the last seq seen
 *   on the previous page (next page starts at seq < cursor). The chat UI
 *   uses desc so its turn-grouping filter always sees the most recent
 *   `turn_end` even when the chat has thousands of events.
 */
export async function listEvents(
  db: Database,
  agentId: string,
  chatId: string,
  options?: { limit?: number; cursor?: number; direction?: "asc" | "desc" },
): Promise<{ items: SessionEventRow[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const direction = options?.direction ?? "asc";

  const conditions = [eq(sessionEvents.agentId, agentId), eq(sessionEvents.chatId, chatId)];
  if (options?.cursor !== undefined) {
    conditions.push(
      direction === "desc" ? lt(sessionEvents.seq, options.cursor) : gt(sessionEvents.seq, options.cursor),
    );
  }

  const rows = await db
    .select({
      id: sessionEvents.id,
      agentId: sessionEvents.agentId,
      chatId: sessionEvents.chatId,
      seq: sessionEvents.seq,
      kind: sessionEvents.kind,
      payload: sessionEvents.payload,
      createdAt: sessionEvents.createdAt,
    })
    .from(sessionEvents)
    .where(and(...conditions))
    .orderBy(direction === "desc" ? desc(sessionEvents.seq) : asc(sessionEvents.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToEvent);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.seq : null;

  return { items, nextCursor };
}

/** Delete all events for a session — called on eviction / termination. */
export async function clearEvents(db: Database, agentId: string, chatId: string): Promise<void> {
  await db.delete(sessionEvents).where(and(eq(sessionEvents.agentId, agentId), eq(sessionEvents.chatId, chatId)));
}

const CONTEXT_TREE_USAGE_FEED_LIMIT = 50;

/**
 * Caller identity needed to decide which chats in the org-wide usage feed
 * the requesting user can see. Matches the membership/supervisor semantics
 * of `requireChatAccess`: a chat is visible if the caller's `humanAgentId`
 * has any `chat_membership` row, or any agent the caller manages (via
 * `memberId`) is a speaker in that chat. Either field may be null when the
 * caller has no human agent / no member row in the org — both branches
 * just yield no visibility.
 */
export type ContextTreeUsageViewer = {
  humanAgentId: string | null;
  memberId: string | null;
};

export async function summarizeContextTreeUsage(
  db: Database,
  organizationId: string,
  windowDays: number,
  viewer: ContextTreeUsageViewer,
): Promise<ContextTreeUsageSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const [aggregate] = await db
    .select({
      agentCount: sql<number>`count(distinct ${sessionEvents.agentId})::int`,
      usageCount: sql<number>`count(*)::int`,
    })
    .from(sessionEvents)
    .innerJoin(agents, eq(agents.uuid, sessionEvents.agentId))
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(sessionEvents.kind, "context_tree_usage"),
        gte(sessionEvents.createdAt, since),
      ),
    );

  // chats is joined under the SAME org as agents — a stale/forged event whose
  // chat_id points at a chat from another org must not leak that chat's topic
  // through this feed. The org filter is duplicated on the chats predicate
  // (rather than relying on the agents-side filter) so the planner cannot
  // pick a join order that exposes the wrong topic. left join keeps the row
  // when the chat is missing or out-of-org — chatTitle degrades to null.
  const recentRows = await db
    .select({
      id: sessionEvents.id,
      agentId: sessionEvents.agentId,
      agentName: agents.displayName,
      chatId: sessionEvents.chatId,
      chatTopic: chats.topic,
      createdAt: sessionEvents.createdAt,
    })
    .from(sessionEvents)
    .innerJoin(agents, eq(agents.uuid, sessionEvents.agentId))
    .leftJoin(chats, and(eq(chats.id, sessionEvents.chatId), eq(chats.organizationId, organizationId)))
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(sessionEvents.kind, "context_tree_usage"),
        gte(sessionEvents.createdAt, since),
      ),
    )
    .orderBy(desc(sessionEvents.createdAt))
    .limit(CONTEXT_TREE_USAGE_FEED_LIMIT);

  const visibleChatIds = await resolveVisibleChats(
    db,
    [...new Set(recentRows.map((row) => row.chatId))],
    viewer,
    organizationId,
  );

  const recentEvents: ContextTreeUsageEvent[] = recentRows.map((row) => {
    const visible = visibleChatIds.has(row.chatId);
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      // Mask both fields together — the chatId itself is identifying
      // information even without the topic. Aggregates above still count
      // every event, only the per-row chat coordinates are gated.
      chatId: visible ? row.chatId : null,
      chatTitle: visible ? row.chatTopic : null,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return {
    windowDays,
    agentCount: aggregate?.agentCount ?? 0,
    usageCount: aggregate?.usageCount ?? 0,
    recentEvents,
  };
}

/**
 * Returns the subset of `chatIds` the viewer can see, using the same rules
 * as `requireChatAccess`: direct chat_membership (speaker OR watcher) on
 * the viewer's human agent, OR any speaker in the chat is managed by the
 * viewer's member id. Both branches also anchor on `chats.organization_id`
 * so a stale/cross-org `chat_membership` row cannot promote a chatId from
 * another org into visibility — `requireChatAccess` resolves the caller
 * inside the chat's own org, so a chat that does not belong to this summary
 * org would never have passed that gate either. Empty input short-circuits
 * before any query is issued.
 */
async function resolveVisibleChats(
  db: Database,
  chatIds: string[],
  viewer: ContextTreeUsageViewer,
  organizationId: string,
): Promise<Set<string>> {
  const visible = new Set<string>();
  if (chatIds.length === 0) return visible;

  if (viewer.humanAgentId) {
    const directRows = await db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .innerJoin(chats, and(eq(chats.id, chatMembership.chatId), eq(chats.organizationId, organizationId)))
      .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.agentId, viewer.humanAgentId)));
    for (const row of directRows) visible.add(row.chatId);
  }

  if (viewer.memberId) {
    const remaining = chatIds.filter((id) => !visible.has(id));
    if (remaining.length > 0) {
      const supervisedRows = await db
        .select({ chatId: chatMembership.chatId })
        .from(chatMembership)
        .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
        .innerJoin(chats, and(eq(chats.id, chatMembership.chatId), eq(chats.organizationId, organizationId)))
        .where(
          and(
            inArray(chatMembership.chatId, remaining),
            eq(chatMembership.accessMode, "speaker"),
            eq(agents.managerId, viewer.memberId),
          ),
        );
      for (const row of supervisedRows) visible.add(row.chatId);
    }
  }

  return visible;
}
