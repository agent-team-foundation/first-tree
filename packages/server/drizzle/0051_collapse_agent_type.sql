-- Collapse the three legacy agent types into two: the row's "actor" axis
-- (`human` vs. everything else) stays in `agents.type`; the
-- "personal vs. shared" axis is now carried entirely by `agents.visibility`
-- (added in migration 0018), so a single `agent` value covers both former
-- `personal_assistant` (visibility=private) and `autonomous_agent`
-- (visibility=organization) rows. Pure data migration — the `type` column
-- itself is unchanged (still `text NOT NULL`), so no DDL is needed.

UPDATE "agents" SET "type" = 'agent' WHERE "type" IN ('personal_assistant', 'autonomous_agent');
