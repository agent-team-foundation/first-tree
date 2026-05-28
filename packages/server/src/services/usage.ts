import type {
  TokenUsageEventPayload,
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
import { BadRequestError } from "../errors.js";

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

/**
 * Per-bucket JSONB key names — derived from `TokenUsageEventPayload` so a
 * rename in the wire schema (PR #637, shared/schemas/session-event.ts) is a
 * compile error here rather than a silent zero column. `keyof` produces a
 * union of literals; assigning into `Record<keyof TokenUsageEventPayload, ...>`
 * keeps both sides in lockstep.
 */
type TokenPayloadKey = keyof TokenUsageEventPayload;
const TOKEN_FIELDS = {
  inputTokens: "inputTokens",
  cachedInputTokens: "cachedInputTokens",
  outputTokens: "outputTokens",
  provider: "provider",
  model: "model",
} satisfies Record<TokenPayloadKey, TokenPayloadKey>;

function sumBigint(field: "inputTokens" | "cachedInputTokens" | "outputTokens") {
  return sql<string>`coalesce(sum((${sessionEvents.payload}->>${TOKEN_FIELDS[field]})::bigint), 0)`;
}

/** Cursor for paginated turn lookups: the `createdAt` of the last seen row. */
function encodeCursor(createdAt: Date): string {
  return Buffer.from(createdAt.toISOString(), "utf8").toString("base64url");
}

/**
 * Decode an opaque pagination cursor. Throws `BadRequestError` on a corrupt /
 * non-base64url / non-ISO value rather than silently falling back to the first
 * page — a fallback would replay the first page on every request and quietly
 * desync paginated UIs (review nit R3 on PR #660).
 */
function decodeCursor(cursor: string): Date {
  let iso: string;
  try {
    iso = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new BadRequestError("invalid cursor");
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestError("invalid cursor");
  }
  return d;
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
      inputTokens: sumBigint("inputTokens"),
      cachedInputTokens: sumBigint("cachedInputTokens"),
      outputTokens: sumBigint("outputTokens"),
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
 * Single-agent summary.
 *
 * Returns:
 *   - `totals` — sums over the requested `[from, to)` window. Drives the KPI
 *     strip and obeys the 7d/30d picker.
 *   - `daily`  — sums grouped by UTC day for the trailing 90 days **relative
 *     to "now"**, independent of `from/to`. The activity grid is a fixed
 *     long-range density visualisation; tying its window to `to` would let a
 *     past `to` value collapse the grid to empty (review nit R2 on PR #660).
 */
export async function summarizeAgent(
  db: Database,
  args: { agentId: string; from: Date; to: Date },
): Promise<UsageAgentSummary> {
  const now = new Date();
  const gridStart = new Date(now.getTime() - ACTIVITY_GRID_DAYS * 24 * 60 * 60 * 1000);

  const [totals] = await db
    .select({
      inputTokens: sumBigint("inputTokens"),
      cachedInputTokens: sumBigint("cachedInputTokens"),
      outputTokens: sumBigint("outputTokens"),
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
      inputTokens: sumBigint("inputTokens"),
      cachedInputTokens: sumBigint("cachedInputTokens"),
      outputTokens: sumBigint("outputTokens"),
      turns: sql<number>`count(${sessionEvents.id})::int`,
    })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.agentId, args.agentId),
        eq(sessionEvents.kind, TOKEN_USAGE_KIND),
        gte(sessionEvents.createdAt, gridStart),
        lt(sessionEvents.createdAt, now),
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
 * per-turn tokens and the chat the turn ran in.
 *
 * Chat-name gating — `chatTitle` (and only the title) is masked to `null`
 * when the caller's `humanAgentId` does NOT have a direct `chat_membership`
 * row for that chat. This is **intentionally narrower** than
 * `requireChatAccess`, which also lets a manager see chats their managed
 * agent speaks in. Rationale (PR #660 review nit R4): the audit list is a
 * cross-chat aggregate surface, not a chat detail page — supervisors who
 * want chat content keep clicking through to the chat-detail route, which
 * still uses the broader `requireChatAccess`. Numbers stay visible in
 * either case ("work volume is public, chat content is not").
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
    const payload = (r.payload ?? {}) as Partial<TokenUsageEventPayload>;
    return {
      seq: r.seq,
      chatId: r.chatId,
      chatTitle: canSeeChat ? (titleMap.get(r.chatId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      inputTokens: Number(payload[TOKEN_FIELDS.inputTokens] ?? 0),
      cachedInputTokens: Number(payload[TOKEN_FIELDS.cachedInputTokens] ?? 0),
      outputTokens: Number(payload[TOKEN_FIELDS.outputTokens] ?? 0),
      provider: payload[TOKEN_FIELDS.provider] ?? "",
      model: payload[TOKEN_FIELDS.model] ?? "",
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

/**
 * Resolve `?from=&to=` query strings into a Date pair with sensible defaults.
 * Throws `BadRequestError` on unparseable input so the caller sees a 400
 * rather than a 500 (review nit R5 on PR #660).
 */
export function resolveUsageWindow(
  q: { from?: string; to?: string },
  defaults: { days: number },
): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw new BadRequestError(`invalid 'to' timestamp: ${q.to}`);
  }
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaults.days * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime())) {
    throw new BadRequestError(`invalid 'from' timestamp: ${q.from}`);
  }
  return { from, to };
}

export const DEFAULT_USAGE_TURNS_LIMIT = DEFAULT_TURNS_LIMIT;
