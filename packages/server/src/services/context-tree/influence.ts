import {
  CONTEXT_DECISION_METADATA_KEY,
  type ContextDecisionEffect,
  type ContextTreeInfluenceEvent,
  type ContextTreeInfluenceNode,
  type ContextTreeInfluenceSummary,
  contextDecisionSchema,
} from "@first-tree/shared";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { accessibleChatIdSet, type ContextTreeIoViewer } from "./io.js";

/**
 * Context Tree INFLUENCE — how often Tree content changed a decision.
 *
 * The source is `messages.metadata.contextDecision`, which the Server derives
 * from the visible impact note when the message is written. Nothing is copied
 * into a second table on purpose: messages are immutable and never deleted, so
 * they already ARE the durable statistics source. (This is where influence
 * differs from `context_tree_io_events`, which exists precisely because its
 * source — `session_events` — is cleared on eviction.) Reading in place also
 * means receipts written before the note existed still count, with no backfill.
 *
 * No dedicated index yet: the `(chat_id, created_at)` and
 * `(organization_id, ...)` indexes already bound every query below to one org's
 * messages in one window, and the receipt key is rare enough inside that window
 * that the residual filter is noise. The snapshot route times each stage and
 * warns past its budget — that instrumentation, not a guess, is what should
 * decide when a partial index earns its migration.
 */

/** Newest decisions shown in the Context tab feed. */
const INFLUENCE_FEED_LIMIT = 20;
/** Ranked nodes shown under the headline. */
const INFLUENCE_NODE_LIMIT = 5;

export type ContextTreeInfluenceOptions = {
  timing?: (stage: string, ms: number, attrs?: Record<string, unknown>) => void;
};

/**
 * Rows in the window whose stored receipt is structurally sound.
 *
 * The shape checks are not redundant with the write boundary: message rows are
 * immutable, so history written before a guard existed is never re-validated.
 * Requiring one of the four effects AND an array `evidence` here keeps the
 * headline count, the effect tally, and the node ranking derived from exactly
 * the same row set — a malformed row cannot inflate one of them and not the
 * others. The array check also has to live here rather than in the node query's
 * WHERE: `jsonb_array_elements` in a LATERAL join is evaluated before that
 * WHERE runs, so a non-array would raise instead of being filtered out.
 */
function influenceRowsSql(organizationId: string, sinceIso: string) {
  return sql`
    WITH influence AS (
      SELECT
        m.id,
        m.sender_id,
        m.metadata -> ${CONTEXT_DECISION_METADATA_KEY} AS decision,
        m.chat_id,
        c.topic AS chat_title,
        m.created_at
      FROM messages m
      INNER JOIN chats c ON c.id = m.chat_id
      WHERE c.organization_id = ${organizationId}
        AND m.created_at >= ${sinceIso}::timestamptz
        AND m.metadata ? ${CONTEXT_DECISION_METADATA_KEY}
        AND m.metadata -> ${CONTEXT_DECISION_METADATA_KEY} ->> 'effect'
            IN ('conflicted', 'redirected', 'constrained', 'confirmed')
        AND jsonb_typeof(m.metadata -> ${CONTEXT_DECISION_METADATA_KEY} -> 'evidence') = 'array'
    )
  `;
}

function numberFrom(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function titleFromNodePath(nodePath: string): string {
  return nodePath.split("/").filter(Boolean).at(-1) ?? nodePath;
}

async function timed<T>(
  options: ContextTreeInfluenceOptions,
  stage: string,
  run: () => Promise<T>,
  attrs?: Record<string, unknown>,
): Promise<T> {
  const startedAt = performance.now();
  const result = await run();
  options.timing?.(stage, performance.now() - startedAt, attrs);
  return result;
}

function emptySummary(windowDays: number): ContextTreeInfluenceSummary {
  return {
    windowDays,
    decisionCount: 0,
    effects: { conflicted: 0, redirected: 0, constrained: 0, confirmed: 0 },
    nodes: [],
    recentEvents: [],
  };
}

/**
 * Org-scoped influence for the Context tab.
 *
 * `decisionCount` counts MESSAGES, not citations: one answer that cites three
 * nodes is one decision the Tree shaped. The node ranking counts the same way
 * (`count(DISTINCT influence.id)`), so a node's number always reads as
 * "decisions this node changed" — and the node numbers can sum past the
 * headline without either being wrong.
 *
 * Three small queries rather than one: the totals query decides whether the
 * other two are worth running at all, and an org with no influence in the
 * window (the common case early on) costs exactly one indexed count.
 */
export async function summarizeContextTreeInfluence(
  db: Database,
  organizationId: string,
  windowDays: number,
  viewer?: ContextTreeIoViewer,
  options: ContextTreeInfluenceOptions = {},
): Promise<ContextTreeInfluenceSummary> {
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = influenceRowsSql(organizationId, sinceIso);

  const [totals] = await timed(options, "influence_totals", () =>
    db.execute<{
      decision_count: number | string;
      conflicted: number | string;
      redirected: number | string;
      constrained: number | string;
      confirmed: number | string;
    }>(sql`
      ${rows}
      SELECT
        count(*) AS decision_count,
        count(*) FILTER (WHERE influence.decision ->> 'effect' = 'conflicted') AS conflicted,
        count(*) FILTER (WHERE influence.decision ->> 'effect' = 'redirected') AS redirected,
        count(*) FILTER (WHERE influence.decision ->> 'effect' = 'constrained') AS constrained,
        count(*) FILTER (WHERE influence.decision ->> 'effect' = 'confirmed') AS confirmed
      FROM influence
    `),
  );

  const decisionCount = numberFrom(totals?.decision_count);
  if (decisionCount === 0) return emptySummary(windowDays);

  const nodeRows = await timed(options, "influence_nodes", () =>
    db.execute<{
      node_path: string;
      decision_count: number | string;
      heading: string | null;
      repo_url: string | null;
      commit: string | null;
    }>(sql`
      ${rows}
      SELECT
        evidence ->> 'nodePath' AS node_path,
        count(DISTINCT influence.id) AS decision_count,
        (array_agg(evidence ->> 'heading' ORDER BY influence.created_at DESC))[1] AS heading,
        (array_agg(evidence ->> 'repoUrl' ORDER BY influence.created_at DESC))[1] AS repo_url,
        (array_agg(evidence ->> 'commit' ORDER BY influence.created_at DESC))[1] AS commit
      FROM influence
      CROSS JOIN LATERAL jsonb_array_elements(influence.decision -> 'evidence') AS evidence
      WHERE evidence ->> 'nodePath' IS NOT NULL
      GROUP BY 1
      ORDER BY decision_count DESC, node_path ASC
      LIMIT ${INFLUENCE_NODE_LIMIT}
    `),
  );

  const eventRows = await timed(options, "influence_events", () =>
    db.execute<{
      id: string;
      agent_id: string;
      agent_name: string | null;
      agent_avatar_color_token: string | null;
      decision: unknown;
      chat_id: string;
      chat_title: string | null;
      created_at: Date | string;
    }>(sql`
      ${rows}
      SELECT
        influence.id,
        influence.sender_id AS agent_id,
        a.display_name AS agent_name,
        a.avatar_color_token AS agent_avatar_color_token,
        influence.decision,
        influence.chat_id,
        influence.chat_title,
        influence.created_at
      FROM influence
      -- LEFT, not INNER: messages.sender_id carries no FK because agents may be
      -- soft-deleted while their messages are preserved. A retired author must
      -- not erase the decision its note recorded.
      LEFT JOIN agents a ON a.uuid = influence.sender_id
      ORDER BY influence.created_at DESC
      LIMIT ${INFLUENCE_FEED_LIMIT}
    `),
  );

  const accessible = viewer
    ? await timed(options, "influence_chat_access", () =>
        accessibleChatIdSet(db, viewer, [...new Set(eventRows.map((row) => row.chat_id))]),
      )
    : new Set<string>();

  const recentEvents: ContextTreeInfluenceEvent[] = [];
  for (const row of eventRows) {
    // Parse defensively: message rows are immutable, so a receipt written
    // before the current guard is never re-validated. A row that fails here is
    // dropped from the FEED but still counted above — the counts run off the
    // same effect check the write boundary enforces, and silently renumbering
    // the headline to match a rendering failure would be the worse lie.
    const parsed = contextDecisionSchema.safeParse(row.decision);
    if (!parsed.success) continue;
    recentEvents.push({
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name ?? "unknown",
      agentAvatarColorToken: row.agent_avatar_color_token,
      effect: parsed.data.effect,
      summary: parsed.data.summary,
      evidence: parsed.data.evidence,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      viewerCanAccess: accessible.has(row.chat_id),
      createdAt: isoOrNull(row.created_at) ?? new Date().toISOString(),
    });
  }

  const nodes: ContextTreeInfluenceNode[] = nodeRows
    .filter((row) => typeof row.node_path === "string" && row.node_path.length > 0 && row.repo_url && row.commit)
    .map((row) => ({
      nodePath: row.node_path,
      title: row.heading?.trim() || titleFromNodePath(row.node_path),
      repoUrl: row.repo_url ?? "",
      commit: row.commit ?? "",
      decisionCount: numberFrom(row.decision_count),
    }));

  const effects: Record<ContextDecisionEffect, number> = {
    conflicted: numberFrom(totals?.conflicted),
    redirected: numberFrom(totals?.redirected),
    constrained: numberFrom(totals?.constrained),
    confirmed: numberFrom(totals?.confirmed),
  };

  return { windowDays, decisionCount, effects, nodes, recentEvents };
}
