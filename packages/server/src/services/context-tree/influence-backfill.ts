import {
  CONTEXT_DECISION_METADATA_KEY,
  contextDecisionFromImpactNote,
  parseContextImpactNotes,
} from "@first-tree/shared";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";

/**
 * One-off backfill: derive `metadata.contextDecision` from the visible Context
 * Tree impact note on agent messages written BEFORE the Server started deriving
 * it at write time (see `services/chat/message.ts`).
 *
 * Between the note replacing the structured receipt and write-time derivation
 * landing, agents wrote perfectly good notes that nothing ever parsed. Those
 * decisions are invisible to the Context tab's influence numbers even though
 * the evidence is sitting in the message body. Receipts written before the note
 * (legacy structured payloads) already count and are left untouched.
 *
 * Lives in `src/` rather than beside its CLI so it is typechecked and testable:
 * it writes to `messages`, whose rows are immutable by contract, so an
 * overwrite or a clobbered sibling key would not be recoverable.
 */

type Row = {
  id: string;
  content: unknown;
  metadata: Record<string, unknown> | null;
  /**
   * The sort key as PostgreSQL renders it, NOT a `Date`. `timestamptz` keeps
   * microseconds while a JavaScript `Date` keeps milliseconds, so a cursor that
   * round-trips through `Date.toISOString()` rounds DOWN — and the next
   * `(created_at, id) > (cursor…)` comparison then re-selects the very row the
   * cursor was meant to skip. With `--max-rows 1` on an unconvertible boundary
   * row, every resumed run would stop on that same row forever.
   */
  created_at_key: string;
};

type Outcome = "derived" | "no_note" | "two_notes" | "unconvertible" | "not_text";

export type BackfillOptions = {
  apply: boolean;
  /**
   * The historical gap this backfill exists to close, as an inclusive window.
   * Required, not defaulted: an unbounded run would let a later operator
   * rewrite messages outside the gap — including rows the write path
   * deliberately left receipt-free — turning a one-off repair into a second,
   * permanent authority over message history.
   */
  since: Date;
  until: Date;
  organizationId?: string;
  /** Rows fetched per page. Pagination is by keyset, so this only bounds memory. */
  pageSize?: number;
  /**
   * Exact upper bound on rows examined in one run — checked per row, not per
   * page, so `--max-rows 100` never touches a 101st message.
   */
  maxRows?: number;
  /**
   * Resume point from a previous run's reported cursor. The keyset cursor lives
   * only in memory during a run, so without this an operator following the
   * "rerun to continue" instruction would restart at the window's beginning and
   * rescan every already-examined row.
   */
  resumeAfter?: { createdAt: string; id: string };
};

export type BackfillReport = {
  scanned: number;
  tally: Record<Outcome, number>;
  unconvertibleSample: string[];
  /** True when `maxRows` stopped the run before the window was exhausted. */
  stoppedAtMaxRows: boolean;
  /**
   * Last row examined, or null when the window was exhausted. Pass it back as
   * `resumeAfter` to continue exactly where this run stopped.
   */
  nextCursor: { createdAt: string; id: string } | null;
};

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_ROWS = 20_000;

function bodyOf(content: unknown): string | null {
  return typeof content === "string" ? content : null;
}

/**
 * Scan the declared window and, when `apply` is set, write the derived receipt.
 *
 * Pagination is by keyset on `(created_at, id)` rather than OFFSET/LIMIT
 * because most candidates are NOT rewritten: no-note, multi-note, and
 * unconvertible rows stay candidates forever and sort first every time. A plain
 * limit would rescan those same ids on every rerun and never reach the
 * convertible messages behind them, while the CLI told the operator to rerun.
 */
export async function backfillContextDecisionFromNotes(
  db: Database,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const { apply, since, until, organizationId } = options;
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw new Error("since must be a valid Date");
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) throw new Error("until must be a valid Date");
  if (since.getTime() > until.getTime()) throw new Error("since must not be after until");
  // A fractional bound is not a bound: `scanned >= 1.5` lets a run examine — and
  // mutate — two rows while advertising one. Reject it at the service, not only
  // at the CLI, so a programmatic caller cannot slip past the same guard.
  for (const [name, value] of [
    ["pageSize", options.pageSize],
    ["maxRows", options.maxRows],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  const tally: Record<Outcome, number> = {
    derived: 0,
    no_note: 0,
    two_notes: 0,
    unconvertible: 0,
    not_text: 0,
  };
  const unconvertibleSample: string[] = [];
  let scanned = 0;
  let stoppedAtMaxRows = false;
  let cursor: { createdAt: string; id: string } | null = options.resumeAfter ?? null;
  let lastExamined: { createdAt: string; id: string } | null = null;

  for (;;) {
    // Candidates: agent-authored text bodies inside the declared window with no
    // receipt yet. The scaffold match is a cheap prefilter — the shared parser
    // is the authority, and it runs on every row this returns.
    const rows: Row[] = await db.execute<Row>(sql`
      SELECT m.id, m.content, m.metadata, m.created_at::text AS created_at_key
      FROM messages m
      INNER JOIN agents a ON a.uuid = m.sender_id
      ${organizationId ? sql`INNER JOIN chats c ON c.id = m.chat_id AND c.organization_id = ${organizationId}` : sql``}
      WHERE a.type <> 'human'
        AND m.created_at >= ${sinceIso}::timestamptz
        AND m.created_at <= ${untilIso}::timestamptz
        AND NOT (COALESCE(m.metadata, '{}'::jsonb) ? ${CONTEXT_DECISION_METADATA_KEY})
        AND jsonb_typeof(m.content) = 'string'
        AND (
          m.content::text LIKE '%How Context Tree affected this work%'
          OR m.content::text LIKE '%Context Tree 如何影响本次工作%'
        )
        ${cursor ? sql`AND (m.created_at, m.id) > (${cursor.createdAt}::timestamptz, ${cursor.id})` : sql``}
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ${pageSize}
    `);
    if (rows.length === 0) break;

    for (const row of rows) {
      // Checked per row so `maxRows` is an exact bound on what this run
      // touches, not "the last page may overshoot it".
      if (scanned >= maxRows) {
        stoppedAtMaxRows = true;
        break;
      }
      scanned += 1;
      lastExamined = { createdAt: row.created_at_key, id: row.id };
      const body = bodyOf(row.content);
      if (body === null) {
        tally.not_text += 1;
        continue;
      }
      const notes = parseContextImpactNotes(body);
      if (notes.length === 0) {
        tally.no_note += 1;
        continue;
      }
      if (notes.length > 1) {
        // Same rule the write path enforces: two notes attribute two different
        // things and picking either would be a guess.
        tally.two_notes += 1;
        continue;
      }
      const note = notes[0];
      const decision = note ? contextDecisionFromImpactNote(note) : null;
      if (!decision) {
        tally.unconvertible += 1;
        if (unconvertibleSample.length < 20) unconvertibleSample.push(row.id);
        continue;
      }
      tally.derived += 1;

      if (apply) {
        // jsonb_set adds exactly this key. A whole-object replace would race any
        // concurrent metadata write on the same row. The NOT-exists predicate is
        // repeated here so a receipt that landed between the scan and this write
        // still wins over the backfill.
        await db.execute(sql`
          UPDATE messages
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            ARRAY[${CONTEXT_DECISION_METADATA_KEY}],
            ${JSON.stringify(decision)}::jsonb,
            true
          )
          WHERE id = ${row.id}
            AND NOT (COALESCE(metadata, '{}'::jsonb) ? ${CONTEXT_DECISION_METADATA_KEY})
        `);
      }
    }

    if (stoppedAtMaxRows) break;
    const last = rows.at(-1);
    if (!last) break;
    cursor = { createdAt: last.created_at_key, id: last.id };
    if (rows.length < pageSize) {
      lastExamined = null;
      break;
    }
  }

  return { scanned, tally, unconvertibleSample, stoppedAtMaxRows, nextCursor: lastExamined };
}
