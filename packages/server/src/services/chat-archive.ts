/**
 * Periodic chat auto-archive sweeper.
 *
 * Replaces the per-event "archive immediately when a PR merges" bypass that
 * lived in the GitHub App webhook. Run from `background-tasks.ts` on a
 * configurable interval.
 *
 * Only SCM-originated chats (`chats.metadata.source IN ('github','gitlab')`) are
 * eligible for automatic archive. The sweep has two provider-neutral branches,
 * both keyed off `chats.last_message_at` as the idleness anchor:
 *
 *   Mapped branch — chats with at least one matching provider mapping row.
 *     Archive (for every mapped human) once *all* bound entities are
 *     terminal (`entity_state` in `('closed','merged')`) AND the chat has
 *     been silent for `mappedIdleSeconds` (default 1h).
 *
 *   No-mapping branch — SCM-originated chats with no mapping rows. Archive
 *     only acknowledged human views once the chat has been silent for the same
 *     idle threshold. This is an explicit SCM orphan/no-binding cleanup,
 *     not the old generic operational-chat idle sweep.
 *
 * A chat with any open structured request (`open_request_count > 0`) is never
 * auto-archived. Per-user unread guards still apply, and user-`deleted` /
 * already-`archived` rows are left alone.
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
export const DEFAULT_SWEEP_BATCH_SIZE = 1000;

export type SweepChatArchiveOptions = {
  /** Idle threshold for SCM-originated archive branches. Default 1h. */
  mappedIdleSeconds?: number;
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
  const batchSize = opts.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE;

  const mappedRowsArchived = await sweepMapped(db, mappedIdle, batchSize);
  const unmappedRowsArchived = await sweepUnmapped(db, mappedIdle, batchSize);
  return { mappedRowsArchived, unmappedRowsArchived };
}

/**
 * Mapped branch: SCM-originated chats whose every provider-mapped entity is
 * terminal AND have been silent for at least `idleSeconds`. Archives every
 * (chat, human) pair from the mapping table, minus per-user unread and
 * chat-level open-request guards.
 *
 * Implemented as a single `INSERT … SELECT … ON CONFLICT` round-trip:
 *  - The CTE enumerates only archivable (chat, human) rows, then applies the
 *    batch limit. Rows that are already archived/deleted, unread, blocked by
 *    an open request, or attached to a non-terminal mapped entity never consume
 *    the batch.
 *  - The per-user unread guard excludes humans whose `unread_mention_count >
 *    0` — the schema column is semantically overloaded as "any kind of unread"
 *    (see chat_user_state docstring and me-chat.ts:markChatUnread), so this
 *    also covers manually-marked-unread chats.
 *  - The `ON CONFLICT … WHERE` guard keeps the write safe under a concurrent
 *    state change between candidate selection and insert/update.
 *  - `parent_chat_id IS NULL` matches `listMeChats`'s defensive filter
 *    — First Tree has no sub-chat product, but historical rows may carry a
 *    non-null value and should stay invisible (and untouched).
 */
async function sweepMapped(db: Database, idleSeconds: number, batchSize: number): Promise<number> {
  const rows = await db.execute<{ chat_id: string }>(sql`
    WITH scm_mappings AS (
      SELECT m.chat_id, m.human_agent_id, m.entity_state
        FROM github_entity_chat_mappings m
        JOIN chats c ON c.id = m.chat_id
       WHERE c.metadata->>'source' = 'github'
      UNION ALL
      SELECT m.chat_id, m.human_agent_id, m.entity_state
        FROM gitlab_entity_chat_mappings m
        JOIN chats c ON c.id = m.chat_id
       WHERE c.metadata->>'source' = 'gitlab'
         AND m.active
         AND m.human_agent_id IS NOT NULL
    ),
    archivable_rows AS (
      SELECT DISTINCT m.chat_id, m.human_agent_id
        FROM scm_mappings m
        JOIN chats c ON c.id = m.chat_id
        LEFT JOIN chat_user_state cus
               ON cus.chat_id = m.chat_id AND cus.agent_id = m.human_agent_id
       WHERE c.parent_chat_id IS NULL
         AND c.last_message_at IS NOT NULL
         AND c.last_message_at < NOW() - make_interval(secs => ${idleSeconds})
         AND NOT EXISTS (
           SELECT 1
             FROM chat_user_state req
           WHERE req.chat_id = c.id
             AND req.open_request_count > 0
         )
         AND NOT EXISTS (
           SELECT 1
             FROM agent_chat_sessions running
            WHERE running.chat_id = c.id
              AND running.runtime_state IN ('working', 'blocked')
         )
         AND NOT EXISTS (
           SELECT 1
             FROM scm_mappings open_m
            WHERE open_m.chat_id = m.chat_id
              AND open_m.entity_state NOT IN ('closed', 'merged')
         )
         AND COALESCE(cus.engagement_status, 'active') = 'active'
         AND COALESCE(cus.unread_mention_count, 0) = 0
       LIMIT ${batchSize}
    )
    INSERT INTO chat_user_state (chat_id, agent_id, unread_mention_count, engagement_status)
    SELECT chat_id, human_agent_id, 0, 'archived'
      FROM archivable_rows
        ON CONFLICT (chat_id, agent_id) DO UPDATE
           SET engagement_status = 'archived'
         WHERE chat_user_state.engagement_status = 'active'
           AND chat_user_state.unread_mention_count = 0
    RETURNING chat_id
  `);
  return rows.length;
}

/**
 * No-mapping branch: SCM-originated chats with no mapping rows that have
 * been silent past `idleSeconds`, restricted to per-(chat, user) rows that all
 * of:
 *
 *   - the user has acknowledged the chat at least once (`last_read_at IS
 *     NOT NULL`) — never auto-archive a view the user has never even
 *     opened; without this guard a never-clicked watcher would find the
 *     chat in their Archived tab without ever having seen it,
 *   - the user has no unread mentions,
 *   - the user's engagement is currently `active` (either an explicit
 *     row or the implicit default via missing row).
 *
 * Like the mapped branch, any open request in the chat blocks archive for the
 * entire chat. Unlike the retired generic Route B, this branch does not require
 * "no human owner": SCM-originated chats are normally human-owned.
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
     WHERE c.metadata->>'source' IN ('github', 'gitlab')
       AND NOT EXISTS (
         SELECT 1
           FROM github_entity_chat_mappings m
          WHERE m.chat_id = c.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM gitlab_entity_chat_mappings m
          WHERE m.chat_id = c.id
            AND m.active
       )
       AND a.type = 'human'
       AND c.parent_chat_id IS NULL
       AND c.last_message_at IS NOT NULL
       AND c.last_message_at < NOW() - make_interval(secs => ${idleSeconds})
       AND NOT EXISTS (
         SELECT 1
           FROM chat_user_state req
          WHERE req.chat_id = c.id
            AND req.open_request_count > 0
       )
       AND NOT EXISTS (
         SELECT 1
           FROM agent_chat_sessions running
          WHERE running.chat_id = c.id
            AND running.runtime_state IN ('working', 'blocked')
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
