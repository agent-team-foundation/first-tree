-- Partial unique index: each user can hold at most one github identity.
--
-- Closes the race window in `findOrCreateUserFromGithub`'s legacy-bind
-- fallback. The fallback runs:
--   1. SELECT users WHERE lower(username) = login AND no github identity
--   2. INSERT new auth_identities row binding (user, github)
-- Two concurrent OAuth callbacks for the SAME legacy user under TWO
-- DIFFERENT githubIds would each pass step 1 (the partial uniqueness on
-- (provider, identifier) only catches duplicates of the same identifier),
-- and both INSERTs would succeed — leaving one user bound to two
-- distinct GitHub accounts. This index makes the second INSERT fail
-- atomically with a unique-violation, which the caller surfaces as a
-- 401 just like any other auth failure.
--
-- Generalizes beyond the legacy fallback: also forbids accidentally
-- double-binding a regular OAuth user (e.g. via a future "merge accounts"
-- flow that double-fires).

CREATE UNIQUE INDEX IF NOT EXISTS "uq_auth_identities_user_github"
  ON "auth_identities" ("user_id")
  WHERE "provider" = 'github';
