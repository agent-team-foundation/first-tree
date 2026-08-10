import {
  CONTEXT_DECISION_METADATA_KEY,
  type ContextDecisionEffect,
  type ContextDecisionEvidence,
  type ContextTreeInfluenceEvent,
  type ContextTreeInfluenceNode,
  type ContextTreeInfluenceSummary,
  canonicalGitRepoUrl,
  contextDecisionSchema,
} from "@first-tree/shared";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { createLogger } from "../../observability/index.js";
import { accessibleChatIdSet, type ContextTreeIoViewer } from "./io.js";

/**
 * Context Tree INFLUENCE — how often Tree content changed a decision.
 *
 * The source is `messages.metadata.contextDecision`, which the Server derives
 * from the visible impact note when the message is written. Nothing is copied
 * into a second table on purpose: messages are immutable and never deleted, so
 * they already ARE the durable statistics source. (This is where influence
 * differs from `context_tree_io_events`, which exists precisely because its
 * source — `session_events` — is cleared on termination.) Reading in place also
 * means receipts written before the note existed still count, with no backfill.
 *
 * Two invariants shape the implementation:
 *
 *   1. **One row set.** Every facet — the headline, the effect tally, the node
 *      ranking, the feed — is computed from the SAME fully schema-valid,
 *      bound-repository-scoped receipts. Counting in SQL while rendering from a
 *      stricter parse would let the headline claim decisions the feed silently
 *      drops, and the discrepancy would be invisible.
 *   2. **Chat content stays behind chat access.** `summary` and `evidence` are
 *      copied out of a private message body, so an event the viewer cannot open
 *      is omitted from the feed entirely rather than shown half-redacted.
 *
 * No dedicated index yet: the `(chat_id, created_at)` and
 * `(organization_id, ...)` indexes already bound the candidate scan to one
 * org's messages in one window, and the receipt key is rare enough inside that
 * window that the residual filter is noise. The snapshot route times each stage
 * and warns past its budget — that instrumentation, not a guess, is what should
 * decide when a partial index earns its migration.
 */

const log = createLogger("ContextTreeInfluence");

/** Newest decisions shown in the Context tab feed. */
const INFLUENCE_FEED_LIMIT = 20;
/** Ranked nodes shown under the headline. */
const INFLUENCE_NODE_LIMIT = 5;
/**
 * Candidate receipts loaded per window. Parsing in JS is what keeps every facet
 * on one row set, and that requires holding the window's receipts in memory.
 * A seven-day org window is orders of magnitude below this; exceeding it means
 * the assumption behind reading `messages` in place has broken, so it is logged
 * as an error rather than silently truncating a number people act on.
 */
const INFLUENCE_SCAN_CAP = 5_000;

export type ContextTreeInfluenceOptions = {
  /**
   * The org's currently bound Context Tree repository. Influence is scoped to
   * it: a receipt citing another repository belongs to a different tree (or to
   * a binding that has since moved) and must not be counted here or merged into
   * the node ranking, where a shared path would otherwise inflate a node that
   * is not the one being displayed.
   */
  boundRepoUrl?: string | null;
  viewer?: ContextTreeIoViewer;
  timing?: (stage: string, ms: number, attrs?: Record<string, unknown>) => void;
};

type CandidateRow = {
  id: string;
  sender_id: string;
  agent_name: string | null;
  agent_avatar_color_token: string | null;
  decision: unknown;
  chat_id: string;
  chat_title: string | null;
  created_at: Date | string;
};

type ValidReceipt = {
  id: string;
  agentId: string;
  agentName: string;
  agentAvatarColorToken: string | null;
  effect: ContextDecisionEffect;
  summary: string;
  /** Already filtered to the bound repository. */
  evidence: ContextDecisionEvidence[];
  chatId: string;
  chatTitle: string | null;
  createdAt: string;
  createdAtMs: number;
};

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
 * Parse one candidate row into a receipt scoped to the bound repository, or
 * `null` when it is not one.
 *
 * A row is dropped whole when its stored payload is not schema-valid — message
 * rows are immutable, so history written before a guard existed is never
 * re-validated — or when none of its citations point at the bound repository.
 * Partial acceptance is the failure mode this function exists to prevent: a
 * receipt counted in the headline but absent from the ranking is a number
 * nobody can reconcile.
 */
function toValidReceipt(row: CandidateRow, expectedRepo: string): ValidReceipt | null {
  const parsed = contextDecisionSchema.safeParse(row.decision);
  if (!parsed.success) return null;

  const evidence = parsed.data.evidence.filter((item) => canonicalGitRepoUrl(item.repoUrl) === expectedRepo);
  if (evidence.length === 0) return null;

  const createdAt = isoOrNull(row.created_at);
  if (createdAt === null) return null;

  return {
    id: row.id,
    agentId: row.sender_id,
    agentName: row.agent_name ?? "unknown",
    agentAvatarColorToken: row.agent_avatar_color_token,
    effect: parsed.data.effect,
    summary: parsed.data.summary,
    evidence,
    chatId: row.chat_id,
    chatTitle: row.chat_title,
    createdAt,
    createdAtMs: Date.parse(createdAt),
  };
}

function rankNodes(receipts: readonly ValidReceipt[]): ContextTreeInfluenceNode[] {
  const byPath = new Map<string, ContextTreeInfluenceNode>();

  // Newest first so the first write of each node carries the most recent
  // citation's heading and commit, and later (older) ones only add to the count.
  for (const receipt of [...receipts].sort((a, b) => b.createdAtMs - a.createdAtMs)) {
    // One decision scores each node once even if the note cited it twice; the
    // shared parser already dedupes, this is the second line of defence.
    const seen = new Set<string>();
    for (const item of receipt.evidence) {
      if (seen.has(item.nodePath)) continue;
      seen.add(item.nodePath);
      const existing = byPath.get(item.nodePath);
      if (existing) {
        existing.decisionCount += 1;
        continue;
      }
      byPath.set(item.nodePath, {
        nodePath: item.nodePath,
        title: item.heading?.trim() || titleFromNodePath(item.nodePath),
        repoUrl: item.repoUrl,
        commit: item.commit,
        decisionCount: 1,
      });
    }
  }

  return [...byPath.values()]
    .sort((a, b) => b.decisionCount - a.decisionCount || a.nodePath.localeCompare(b.nodePath))
    .slice(0, INFLUENCE_NODE_LIMIT);
}

/**
 * Org-scoped influence for the Context tab.
 *
 * `decisionCount` counts MESSAGES, not citations: one answer that cites three
 * nodes is one decision the Tree shaped. The node ranking counts the same way,
 * so a node's number always reads as "decisions this node changed" — and the
 * node numbers can sum past the headline without either being wrong.
 *
 * Aggregates stay org-wide (matching the io summary, which already exposes
 * per-node read activity org-wide); only the feed narrows to chats the viewer
 * may open, because only the feed carries body-derived prose.
 */
export async function summarizeContextTreeInfluence(
  db: Database,
  organizationId: string,
  windowDays: number,
  options: ContextTreeInfluenceOptions = {},
): Promise<ContextTreeInfluenceSummary> {
  // Without a binding there is no tree to attribute influence to, and an
  // unscoped ranking would merge nodes from whatever repositories happen to be
  // cited. Report nothing rather than something unattributable.
  const expectedRepo = options.boundRepoUrl ? canonicalGitRepoUrl(options.boundRepoUrl) : null;
  if (!expectedRepo) return emptySummary(windowDays);

  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = await timed(options, "influence_candidates", () =>
    db.execute<CandidateRow>(sql`
      SELECT
        m.id,
        m.sender_id,
        a.display_name AS agent_name,
        a.avatar_color_token AS agent_avatar_color_token,
        m.metadata -> ${CONTEXT_DECISION_METADATA_KEY} AS decision,
        m.chat_id,
        c.topic AS chat_title,
        m.created_at
      FROM messages m
      INNER JOIN chats c ON c.id = m.chat_id
      -- LEFT, not INNER: messages.sender_id carries no FK because agents may be
      -- soft-deleted while their messages are preserved. A retired author must
      -- not erase the decision its note recorded.
      LEFT JOIN agents a ON a.uuid = m.sender_id
      WHERE c.organization_id = ${organizationId}
        AND m.created_at >= ${sinceIso}::timestamptz
        AND m.metadata ? ${CONTEXT_DECISION_METADATA_KEY}
      ORDER BY m.created_at DESC
      LIMIT ${INFLUENCE_SCAN_CAP}
    `),
  );

  if (rows.length >= INFLUENCE_SCAN_CAP) {
    log.error(
      { event: "context_influence_scan_cap_reached", organizationId, windowDays, cap: INFLUENCE_SCAN_CAP },
      "Context Tree influence candidates hit the scan cap; counts for this window are truncated",
    );
  }

  const receipts: ValidReceipt[] = [];
  for (const row of rows) {
    const receipt = toValidReceipt(row, expectedRepo);
    if (receipt) receipts.push(receipt);
  }
  if (receipts.length === 0) return emptySummary(windowDays);

  const effects: Record<ContextDecisionEffect, number> = {
    conflicted: 0,
    redirected: 0,
    constrained: 0,
    confirmed: 0,
  };
  for (const receipt of receipts) effects[receipt.effect] += 1;

  // Fail closed: with no viewer, nobody has proven chat access, so no
  // body-derived prose leaves the Server.
  const feedCandidates = [...receipts].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const accessible = options.viewer
    ? await timed(options, "influence_chat_access", () =>
        accessibleChatIdSet(db, options.viewer as ContextTreeIoViewer, [
          ...new Set(feedCandidates.map((receipt) => receipt.chatId)),
        ]),
      )
    : new Set<string>();

  const recentEvents: ContextTreeInfluenceEvent[] = feedCandidates
    .filter((receipt) => accessible.has(receipt.chatId))
    .slice(0, INFLUENCE_FEED_LIMIT)
    .map((receipt) => ({
      id: receipt.id,
      agentId: receipt.agentId,
      agentName: receipt.agentName,
      agentAvatarColorToken: receipt.agentAvatarColorToken,
      effect: receipt.effect,
      summary: receipt.summary,
      evidence: receipt.evidence,
      chatId: receipt.chatId,
      chatTitle: receipt.chatTitle,
      createdAt: receipt.createdAt,
    }));

  return {
    windowDays,
    decisionCount: receipts.length,
    effects,
    nodes: rankNodes(receipts),
    recentEvents,
  };
}
