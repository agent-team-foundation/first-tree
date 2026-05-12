-- Backfill: in any group chat, flip every non-human agent participant to
-- `mention_only`. Companion to 0029, which only covered direct chats.
--
-- Why: 0029 left group chats untouched, assuming `maybeUpgradeDirectToGroup`
-- enforced the rule. But chats created directly with `type='group'` (via
-- `createMeChat` / SDK `createChat`) never went through the upgrade path,
-- so their agent participants stayed in the schema-default `'full'` mode.
-- This caused mention_only routing to silently fail (see Phase 1 design doc
-- §1.1 — the `github-webhook-refactor` group chat incident on 2026-05-12,
-- where every agent participant got woken up because mode was `'full'`).
--
-- Phase 1 redirects all writes through `services/participant-mode.ts` so
-- new rows arrive correctly; this migration corrects the historical rows
-- that pre-date the refactor.
--
-- Operational note: run `SELECT count(*) FROM chat_participants cp
-- JOIN chats c ON c.id = cp.chat_id JOIN agents a ON a.uuid = cp.agent_id
-- WHERE c.type = 'group' AND a.type <> 'human' AND cp.mode = 'full'` before
-- and after to attach a row-count to the PR description.
--
-- Migration 0038 is hand-written to match the team's post-0019 workflow
-- (drizzle-kit `generate`'s snapshot metadata is incomplete pre-0019 and
-- refuses to diff — see the commit message on 0032).

UPDATE "chat_participants" AS cp
   SET "mode" = 'mention_only'
  FROM "chats" AS c, "agents" AS a
 WHERE cp."chat_id" = c."id"
   AND cp."agent_id" = a."uuid"
   AND c."type" = 'group'
   AND a."type" <> 'human'
   AND cp."mode" <> 'mention_only';
