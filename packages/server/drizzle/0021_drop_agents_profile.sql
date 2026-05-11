-- PRD D7: remove `agents.profile` column and all dependent code paths.
-- The column was backfilled into `agent_configs.payload.prompt.append` by
-- migration 0018. After this migration, agent behavior instructions live
-- exclusively in `agent_configs`; the `profile` column is dead weight.
--
-- Callers that used to read/write `profile` have been updated in the same
-- release; operators must deploy this migration together with the matching
-- code change — no compatibility layer.

ALTER TABLE "agents" DROP COLUMN IF EXISTS "profile";
