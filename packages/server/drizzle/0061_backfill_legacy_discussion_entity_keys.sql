DELETE FROM "github_entity_chat_mappings" AS legacy
USING "github_entity_chat_mappings" AS canonical
WHERE legacy."entity_type" = 'discussion'
  AND legacy."entity_key" ~ '#discussion-[0-9]+$'
  AND canonical."organization_id" = legacy."organization_id"
  AND canonical."human_agent_id" = legacy."human_agent_id"
  AND canonical."delegate_agent_id" = legacy."delegate_agent_id"
  AND canonical."entity_type" = 'discussion'
  AND canonical."entity_key" = regexp_replace(legacy."entity_key", '#discussion-([0-9]+)$', '#\1');

UPDATE "github_entity_chat_mappings"
SET "entity_key" = regexp_replace("entity_key", '#discussion-([0-9]+)$', '#\1')
WHERE "entity_type" = 'discussion'
  AND "entity_key" ~ '#discussion-[0-9]+$';
