-- Partial unique index: each user can hold at most one github identity.
--
-- Defense-in-depth. The (provider, identifier) UNIQUE catches duplicates
-- of the SAME githubId, but does not stop a single user from collecting
-- multiple DIFFERENT githubIds (e.g. a future "merge accounts" or
-- "rebind" flow that misfires, or a one-off SQL migration that errs).
-- This index makes any such double-bind fail atomically with a
-- unique-violation at the storage layer.

CREATE UNIQUE INDEX IF NOT EXISTS "uq_auth_identities_user_github"
  ON "auth_identities" ("user_id")
  WHERE "provider" = 'github';
