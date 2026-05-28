import type {
  UsageAgentSummary,
  UsageByAgentRow,
  UsageDailyBucket,
  UsageTurnRow,
  UsageTurnsResponse,
} from "@first-tree/shared";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { sessionEvents } from "../db/schema/session-events.js";

/**
 * Token-usage aggregation surface. Reads `token_usage` rows from
 * `session_events` and projects them into the three shapes the web
 * Team / Agent-profile pages need.
 *
 * Backed by the partial index `idx_session_events_token_usage_agent_recent`
 * (migration 0053) — every public function in here filters
 * `kind = 'token_usage'` so the planner can use it.
 *
 * Org isolation is enforced via `agents.organization_id` (the
 * `session_events` row itself has no org column). Chat-name access is
 * gated separately via the optional `viewer` argument — aggregate numbers
 * are org-public, chat names are participant-gated.
 */

const TOKEN_USAGE_KIND = "token_usage";
const ACTIVITY_GRID_DAYS = 90;
const DEFAULT_TURNS_LIMIT = 50;
const MAX_TURNS_LIMIT = 200;

/** Cursor for paginated turn lookups: the `createdAt` of the last seen row. */
function encodeCursor(createdAt: Date): string {
  return Buffer.from(createdAt.toISOString(), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Date | null {
  try {
    const iso = Buffer.from(cursor, "base64url").toString("utf8");
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Viewer identity for chat-name gating. Aggregate numbers do not need this. */
export type UsageViewer = {
  /** The caller's HUMAN-agent uuid in this org (the chat_membership anchor). */
  humanAgentId: string;
};

/**
 * Per-agent aggregate over the given window for one org. Returns one row per
 * agent in the org with `type = 'agent'`, including agents that produced no
 * `token_usage` events in the window (zeros). Drives the Team page Usage
 * column; callers filter zero rows client-side via the "Show idle agents"
 * toggle.
 */
export async function aggregateByAgent(
  db: Database,
  args: { organizationId: string; from: Date; to: Date },
): Promise<UsageByAgentRow[]> {
  const rows = await db
    .select({
      agentId: agents.uuid,
      inputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'inputTokens')::bigint), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'cachedInputTokens')::bigint), 0)`,
      outputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'outputTokens')::bigint), 0)`,
      turns: sql<number>`count(${sessionEvents.id})::int`,
    })
    .from(agents)
    .leftJoin(
      sessionEvents,
      and(
        eq(sessionEvents.agentId, agents.uuid),
        eq(sessionEvents.kind, TOKEN_USAGE_KIND),
        gte(sessionEvents.createdAt, args.from),
        lt(sessionEvents.createdAt, args.to),
      ),
    )
    .where(and(eq(agents.organizationId, args.organizationId), eq(agents.type, "agent")))
    .groupBy(agents.uuid);

  return rows.map(
    (r: { agentId: string; inputTokens: string; cachedInputTokens: string; outputTokens: string; turns: number }) => ({
      agentId: r.agentId,
      // Drizzle returns `bigint` columns as strings to preserve precision;
      // token counts are well below 2^53 so Number() is safe and the wire
      // schema is `z.number().int().nonnegative()`.
      inputTokens: Number(r.inputTokens),
      cachedInputTokens: Number(r.cachedInputTokens),
      outputTokens: Number(r.outputTokens),
      turns: r.turns,
    }),
  );
}

/**
 * Single-agent summary: window totals + a 90-day daily series for the
 * activity grid. Two queries (totals + daily) — kept separate so the totals
 * use the requested `[from, to)` window while the daily series always
 * covers the trailing 90 days ending at `to` regardless of the filter.
 */
export async function summarizeAgent(
  db: Database,
  args: { agentId: string; from: Date; to: Date },
): Promise<UsageAgentSummary> {
  const gridStart = new Date(args.to.getTime() - ACTIVITY_GRID_DAYS * 24 * 60 * 60 * 1000);

  const [totals] = await db
    .select({
      inputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'inputTokens')::bigint), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'cachedInputTokens')::bigint), 0)`,
      outputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'outputTokens')::bigint), 0)`,
      turns: sql<number>`count(${sessionEvents.id})::int`,
      chats: sql<number>`count(distinct ${sessionEvents.chatId})::int`,
      // pg/drizzle returns timestamp aggregates as strings; normalise below.
      lastUsageAt: sql<string | null>`max(${sessionEvents.createdAt})`,
    })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.agentId, args.agentId),
        eq(sessionEvents.kind, TOKEN_USAGE_KIND),
        gte(sessionEvents.createdAt, args.from),
        lt(sessionEvents.createdAt, args.to),
      ),
    );

  const dailyRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${sessionEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      inputTokens: sql<string>`sum((${sessionEvents.payload}->>'inputTokens')::bigint)`,
      cachedInputTokens: sql<string>`sum((${sessionEvents.payload}->>'cachedInputTokens')::bigint)`,
      outputTokens: sql<string>`sum((${sessionEvents.payload}->>'outputTokens')::bigint)`,
      turns: sql<number>`count(${sessionEvents.id})::int`,
    })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.agentId, args.agentId),
        eq(sessionEvents.kind, TOKEN_USAGE_KIND),
        gte(sessionEvents.createdAt, gridStart),
        lt(sessionEvents.createdAt, args.to),
      ),
    )
    .groupBy(sql`date_trunc('day', ${sessionEvents.createdAt} at time zone 'UTC')`)
    .orderBy(sql`date_trunc('day', ${sessionEvents.createdAt} at time zone 'UTC')`);

  const daily: UsageDailyBucket[] = dailyRows.map((r) => ({
    date: r.day,
    inputTokens: Number(r.inputTokens),
    cachedInputTokens: Number(r.cachedInputTokens),
    outputTokens: Number(r.outputTokens),
    turns: r.turns,
  }));

  return {
    agentId: args.agentId,
    from: args.from.toISOString(),
    to: args.to.toISOString(),
    totals: {
      inputTokens: Number(totals?.inputTokens ?? 0),
      cachedInputTokens: Number(totals?.cachedInputTokens ?? 0),
      outputTokens: Number(totals?.outputTokens ?? 0),
      turns: totals?.turns ?? 0,
      chats: totals?.chats ?? 0,
      lastUsageAt: totals?.lastUsageAt ? new Date(totals.lastUsageAt).toISOString() : null,
    },
    daily,
  };
}

/**
 * Paginated list of individual turns for one agent. Each row carries the
 * per-turn tokens and the chat the turn ran in. `chatTitle` is gated by
 * `viewer` — when the viewer is not a participant of a chat, that chat's
 * title (and id, for safety) are masked. Aggregate token numbers stay
 * visible: the principle is "work volume is public, chat content is not".
 */
export async function listAgentTurns(
  db: Database,
  args: {
    agentId: string;
    from: Date;
    to: Date;
    cursor: string | null;
    limit: number;
    viewer: UsageViewer | null;
  },
): Promise<UsageTurnsResponse> {
  const limit = Math.min(Math.max(args.limit, 1), MAX_TURNS_LIMIT);
  const beforeAt = args.cursor ? decodeCursor(args.cursor) : null;

  const conditions = [
    eq(sessionEvents.agentId, args.agentId),
    eq(sessionEvents.kind, TOKEN_USAGE_KIND),
    gte(sessionEvents.createdAt, args.from),
    lt(sessionEvents.createdAt, args.to),
  ];
  if (beforeAt) conditions.push(lt(sessionEvents.createdAt, beforeAt));

  const rawRows = await db
    .select({
      seq: sessionEvents.seq,
      chatId: sessionEvents.chatId,
      createdAt: sessionEvents.createdAt,
      payload: sessionEvents.payload,
    })
    .from(sessionEvents)
    .where(and(...conditions))
    .orderBy(sql`${sessionEvents.createdAt} DESC`)
    .limit(limit + 1);

  const hasMore = rawRows.length > limit;
  const page = hasMore ? rawRows.slice(0, limit) : rawRows;

  // Batch-resolve chat titles + viewer access in two queries.
  const chatIds: string[] = Array.from(new Set(page.map((r) => r.chatId)));
  const titleMap = new Map<string, string | null>();
  const accessible = new Set<string>();
  if (chatIds.length > 0) {
    const chatRows = await db
      .select({ id: chats.id, topic: chats.topic })
      .from(chats)
      .where(inArray(chats.id, chatIds));
    for (const c of chatRows) titleMap.set(c.id, c.topic);

    if (args.viewer) {
      const membershipRows = await db
        .select({ chatId: chatMembership.chatId })
        .from(chatMembership)
        .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.agentId, args.viewer.humanAgentId)));
      for (const m of membershipRows) accessible.add(m.chatId);
    }
  }

  const rows: UsageTurnRow[] = page.map((r) => {
    const canSeeChat = accessible.has(r.chatId);
    const payload = (r.payload ?? {}) as {
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      provider?: string;
      model?: string;
    };
    return {
      seq: r.seq,
      chatId: r.chatId,
      chatTitle: canSeeChat ? (titleMap.get(r.chatId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      inputTokens: Number(payload.inputTokens ?? 0),
      cachedInputTokens: Number(payload.cachedInputTokens ?? 0),
      outputTokens: Number(payload.outputTokens ?? 0),
      provider: payload.provider ?? "",
      model: payload.model ?? "",
    };
  });

  const lastRow = page.at(-1);
  const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.createdAt) : null;

  return {
    agentId: args.agentId,
    from: args.from.toISOString(),
    to: args.to.toISOString(),
    rows,
    nextCursor,
  };
}

/** Resolve `?from=&to=` query strings into Date pair with sensible defaults. */
export function resolveUsageWindow(
  q: { from?: string; to?: string },
  defaults: { days: number },
): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaults.days * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("invalid from/to");
  }
  return { from, to };
}

export const DEFAULT_USAGE_TURNS_LIMIT = DEFAULT_TURNS_LIMIT;
