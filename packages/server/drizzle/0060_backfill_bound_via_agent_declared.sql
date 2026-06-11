-- Custom SQL migration file, put your code below! --

-- Data-only backfill: the session-event auto-binder (the sole writer of
-- bound_via = 'agent_created') is removed in the same release that introduces
-- the explicit `github follow` command. Semantically an auto-binder row was
-- always "the system declared the binding on the agent's behalf", so legacy
-- rows fold into the new explicit value. No schema change — `bound_via` is a
-- plain text column; the enum lives at the Zod layer.
UPDATE github_entity_chat_mappings
   SET bound_via = 'agent_declared'
 WHERE bound_via = 'agent_created';
