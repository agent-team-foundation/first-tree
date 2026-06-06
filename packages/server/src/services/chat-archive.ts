/**
 * Periodic chat auto-archive sweeper.
 *
 * Replaces the per-event "archive immediately when a PR merges" bypass that
 * lived in the GitHub App webhook. Run from `background-tasks.ts` on a
 * configurable interval.
 *
 * Two routes share the sweep, both keyed off `chats.last_message_at` as the
 * idleness anchor:
 *
 *   Route A — github-minted chats (`chats.metadata.source = 'github'`) with
 *     at least one `github_entity_chat_mappings` row. Archive (for every
 *     mapped human) once *all* bound entities are terminal (`entity_state`
 *     in `('closed','merged')`) AND the chat has been silent for
 *     `mappedIdleSeconds` (default 1h). Additionally: skip individual users
 *     whose `unread_mention_count > 0`. A manual chat that merely acquired a
 *     mapping row (e.g. an `agent_created` binding) is NOT github-minted and
 *     is never archived here (issue #745).
 *
 *   Route B — chats with no GitHub mapping and no human owner. Archive only
 *     the (chat, user) pairs where the user has no unread mentions AND the
 *     chat has been silent for `unmappedIdleSeconds` (default 12h). Human-
 *     owned chats are user-created workspace conversations and must stay
 *     active until explicitly archived.
 *
 * Per-user safety: writes use the same UPSERT + setWhere guard as the
 * removed `archiveChatsForMergedPr` — only implicit-active or
 * explicitly-active rows flip. User-`deleted` and already-`archived` rows
 * are left alone. Idempotent under repeated sweeps and safe under multiple
 * concurrent server instances (the guard short-circuits redundant writes).
 *
 * Auto-revive (chat-projection.applyAfterFanOut) is unchanged: a new
 * message in an archived chat still flips it back to `active`.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

export const DEFAULT_MAPPED_IDLE_SECONDS = 60 * 60; // 1 hour
export const DEFAULT_UNMAPPED_IDLE_SECONDS = 12 * 60 * 60; // 12 hours
export const DEFAULT_SWEEP_BATCH_SIZE = 1000;

export type SweepChatArchiveOptions = {
  /** Idle threshold for Route A (chats with GitHub mappings). Default 1h. */
  mappedIdleSeconds?: number;
  /** Idle threshold for Route B (chats without GitHub mappings). Default 12h. */
  unmappedIdleSeconds?: number;
  /** Max candidate rows per route per tick. Default 1000. */
  batchSize?: number;
};

export type SweepChatArchiveResult = {
  mappedRowsArchived: number;
  unmappedRowsArchived: number;
};

export async function sweepChatArchive(
  db: Database,
  opts: SweepChatArchiveOptions = {},
): Promise<SweepChatArchiveResult> {
  const mappedIdle = opts.mappedIdleSeconds ?? DEFAULT_MAPPED_IDLE_SECONDS;
  const unmappedIdle = opts.unmappedIdleSeconds ?? DEFAULT_UNMAPPED_IDLE_SECONDS;
  const batchSize = opts.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE;

  const mappedRowsArchived = await sweepMapped(db, mappedIdle, batchSize);
  const unmappedRowsArchived = await sweepUnmapped(db, unmappedIdle, batchSize);
  return { mappedRowsArchived, unmappedRowsArchived };
}

/**
 * Route A: chats whose every GitHub-mapped entity is terminal AND have been
 * silent for at least `idleSeconds`. Archives every (chat, human) pair from
 * the mapping table — matches the legacy `archiveChatsForMergedPr` reach,
 * minus the per-user unread carve-out added here.
 *
 * Implemented as a single `INSERT … SELECT … ON CONFLICT` round-trip:
 *  - The inner CTE picks chats that are github-minted (`metadata->>'source'
 *    = 'github'`) and whose `BOOL_AND(entity_state IN ('closed','merged'))`
 *    and idle timestamp both hold. The github-origin filter keeps a manual
 *    chat carrying an `agent_created` mapping row out of the sweep (#745).
 *  - The outer SELECT joins back to the mapping table for the (chat,
 *    human) pairs. A second per-user guard excludes humans whose
 *    `unread_mention_count > 0` — the schema column is semantically
 *    overloaded as "any kind of unread" (see chat_user_state docstring and
 *    me-chat.ts:markChatUnread), so this also covers manually-marked-unread
 *    chats.
 *  - A LEFT JOIN on `chat_user_state` filters out rows that are already
 *    `archived`/`deleted` so we never even SELECT them again on the next
 *    tick (the `ON CONFLICT … WHERE` guard handles the race window).
 *  - `parent_chat_id IS NULL` matches `listMeChats`'s defensive filter
 *    — First Tree has no sub-chat product, but historical rows may carry a
 *    non-null value and should stay invisible (and untouched).
 */
async function sweepMapped(db: Database, idleSeconds: number, batchSize: number): Promise<number> {
  const rows = await db.execute<{ chat_id: string }>(sql`
    WITH eligible_chats AS (
      SELECT m.chat_id
        FROM github_entity_chat_mappings m
        JOIN chats c ON c.id = m.chat_id
       WHERE c.parent_chat_id IS NULL
         -- issue #745: only github-minted chats are auto-archived. A manual
         -- chat that later picked up a mapping row (e.g. an agent_created
         -- binding when an agent opens a PR from inside it) is not
         -- github-minted and must be left alone — the human-owner carve-out
         -- in Route B only covers no-mapping chats, so this is the matching
         -- guard for the mapped route. Same discriminator the conversation
         -- list classifies on (me-chat.ts KNOWN_NON_MANUAL_PREDICATE).
         AND c.metadata->>'source' = 'github'
         AND c.last_message_at IS NOT NULL
         AND c.last_message_at < NOW() - make_interval(secs => ${idleSeconds})
       GROUP BY m.chat_id
      HAVING bool_and(m.entity_state IN ('closed', 'merged'))
       LIMIT ${batchSize}
    )
    INSERT INTO chat_user_state (chat_id, agent_id, unread_mention_count, engagement_status)
    SELECT DISTINCT m.chat_id, m.human_agent_id, 0, 'archived'
      FROM github_entity_chat_mappings m
      JOIN eligible_chats e ON e.chat_id = m.chat_id
      LEFT JOIN chat_user_state cus
             ON cus.chat_id = m.chat_id AND cus.agent_id = m.human_agent_id
     WHERE COALESCE(cus.engagement_status, 'active') = 'active'
       AND COALESCE(cus.unread_mention_count, 0) = 0
        ON CONFLICT (chat_id, agent_id) DO UPDATE
           SET engagement_status = 'archived'
         WHERE chat_user_state.engagement_status = 'active'
           AND chat_user_state.unread_mention_count = 0
    RETURNING chat_id
  `);
  return rows.length;
}

/**
 * Route B: chats with no GitHub mapping and no human owner that have been
 * silent past `idleSeconds`, restricted to per-(chat, user) rows that all of:
 *
 *   - the chat is not owned by a human speaker — human-owned chats are
 *     manually created workspace conversations and should not disappear from
 *     Active merely because they are quiet,
 *   - the user has acknowledged the chat at least once (`last_read_at IS
 *     NOT NULL`) — never auto-archive a view the user has never even
 *     opened; without this guard a never-clicked watcher would find the
 *     chat in their Archived tab without ever having seen it,
 *   - the user has no unread mentions,
 *   - the user's engagement is currently `active` (either an explicit
 *     row or the implicit default via missing row).
 *
 * The `last_read_at IS NOT NULL` condition implies `cus` is materialised,
 * so the `COALESCE(cus.engagement_status, 'active') = 'active'` clause
 * effectively reduces to `engagement_status = 'active'`. The COALESCE is
 * left in place for resilience — historical rows that predate the engagement
 * column were backfilled to `'active'` so this is a no-op today, but the
 * defensive read shape costs nothing.
 *
 * Implementation note: `chat_user_state` rows are lazy-materialised, so
 * the candidate set is enumerated via `chat_membership` (filtered to
 * humans) with an INNER JOIN on the state table — implicit-active users
 * intentionally do NOT match (see "the user has acknowledged" above).
 */
async function sweepUnmapped(db: Database, idleSeconds: number, batchSize: number): Promise<number> {
  const rows = await db.execute<{ chat_id: string }>(sql`
    INSERT INTO chat_user_state (chat_id, agent_id, unread_mention_count, engagement_status)
    SELECT cm.chat_id, cm.agent_id, cus.unread_mention_count, 'archived'
      FROM chat_membership cm
      JOIN chats c ON c.id = cm.chat_id
      JOIN agents a ON a.uuid = cm.agent_id
      JOIN chat_user_state cus
             ON cus.chat_id = cm.chat_id AND cus.agent_id = cm.agent_id
      LEFT JOIN github_entity_chat_mappings m ON m.chat_id = cm.chat_id
     WHERE m.chat_id IS NULL
       AND a.type = 'human'
       AND c.parent_chat_id IS NULL
       AND c.last_message_at IS NOT NULL
       AND c.last_message_at < NOW() - make_interval(secs => ${idleSeconds})
       AND NOT EXISTS (
         SELECT 1
           FROM chat_membership owner_cm
           JOIN agents owner_a ON owner_a.uuid = owner_cm.agent_id
          WHERE owner_cm.chat_id = c.id
            AND owner_cm.role = 'owner'
            AND owner_a.type = 'human'
       )
       AND cus.last_read_at IS NOT NULL
       AND cus.unread_mention_count = 0
       AND cus.engagement_status = 'active'
     LIMIT ${batchSize}
        ON CONFLICT (chat_id, agent_id) DO UPDATE
           SET engagement_status = 'archived'
         WHERE chat_user_state.engagement_status = 'active'
           AND chat_user_state.unread_mention_count = 0
    RETURNING chat_id
  `);
  return rows.length;
}
