-- Backfill: in any direct chat with no human participant, flip both agents to
-- `mention_only`. New direct chats created by `findOrCreateDirectChat` and
-- `createChat` already encode this rule at insert time; this migration patches
-- chats created before the rule existed.
--
-- Why: `full` mode in agent↔agent direct chats causes a reply loop. Every
-- message wakes the other party unconditionally, so a courtesy "thanks" or
-- a duplicated "已回复" tool echo gets treated as a fresh prompt and the two
-- agents chat forever. `mention_only` makes engagement opt-in via `@` so
-- conversations naturally end. Human↔agent direct stays `full` because in a
-- 1:1 with a person the agent must respond on every turn — the human
-- participant is what flips the rule off.
--
-- Group chats are intentionally untouched. Existing rule
-- (`maybeUpgradeDirectToGroup`) already enforces mention_only for non-human
-- participants there.

UPDATE "chat_participants"
SET "mode" = 'mention_only'
WHERE "chat_id" IN (
	SELECT c."id" FROM "chats" c
	WHERE c."type" = 'direct'
	  AND NOT EXISTS (
	    SELECT 1 FROM "chat_participants" cp
	    INNER JOIN "agents" a ON a."uuid" = cp."agent_id"
	    WHERE cp."chat_id" = c."id" AND a."type" = 'human'
	  )
);
