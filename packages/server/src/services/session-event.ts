import type {
  ContextTreeUsageSummary,
  SessionEvent,
  SessionEventKind,
} from "@agent-team-foundation/first-tree-hub-shared";
import { sessionEventSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, asc, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { uuidv7 } from "../uuid.js";

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
      return rowToEvent({
        id: row.id,
        agentId: row.agent_id,
        chatId: row.chat_id,
        seq: row.seq,
        kind: row.kind,
        payload: row.payload,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      });
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

export async function summarizeContextTreeUsage(
  db: Database,
  organizationId: string,
  windowDays: number,
): Promise<ContextTreeUsageSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const [row] = await db
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

  return {
    windowDays,
    agentCount: row?.agentCount ?? 0,
    usageCount: row?.usageCount ?? 0,
  };
}
