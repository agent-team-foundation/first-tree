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
  chat_id: string;
  content: unknown;
  metadata: Record<string, unknown> | null;
};

type Outcome = "derived" | "no_note" | "two_notes" | "unconvertible" | "not_text";

export type BackfillOptions = {
  apply: boolean;
  limit: number;
  organizationId?: string;
};

export type BackfillReport = {
  scanned: number;
  tally: Record<Outcome, number>;
  unconvertibleSample: string[];
};

function bodyOf(content: unknown): string | null {
  return typeof content === "string" ? content : null;
}

/**
 * Scan candidates and, when `apply` is set, write the derived receipt.
 *
 * Exported so the guards can be tested against a real database — this writes to
 * `messages`, whose rows are immutable by contract, so an overwrite or a
 * clobbered sibling key would not be recoverable.
 */
export async function backfillContextDecisionFromNotes(
  db: Database,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const { apply, limit, organizationId } = options;

  // Candidates: agent-authored text bodies with no receipt yet. The scaffold
  // match is a cheap prefilter — the shared parser is the authority, and it
  // runs on every row this returns.
  const rows = await db.execute<Row>(sql`
    SELECT m.id, m.chat_id, m.content, m.metadata
    FROM messages m
    INNER JOIN agents a ON a.uuid = m.sender_id
    ${organizationId ? sql`INNER JOIN chats c ON c.id = m.chat_id AND c.organization_id = ${organizationId}` : sql``}
    WHERE a.type <> 'human'
      AND NOT (COALESCE(m.metadata, '{}'::jsonb) ? ${CONTEXT_DECISION_METADATA_KEY})
      AND jsonb_typeof(m.content) = 'string'
      AND (
        m.content::text LIKE '%How Context Tree affected this work%'
        OR m.content::text LIKE '%Context Tree 如何影响本次工作%'
        OR m.content::text LIKE '%Context Tree impact%'
        OR m.content::text LIKE '%Context Tree 影响%'
      )
    ORDER BY m.created_at ASC
    LIMIT ${limit}
  `);

  const tally: Record<Outcome, number> = {
    derived: 0,
    no_note: 0,
    two_notes: 0,
    unconvertible: 0,
    not_text: 0,
  };
  const unconvertibleSample: string[] = [];

  for (const row of rows) {
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

  return { scanned: rows.length, tally, unconvertibleSample };
}
